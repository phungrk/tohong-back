import { createOrchestrator } from "../lib/factory.js";
import { makeConversationStore } from "../lib/conversationStore.js";
import { buildChatContext } from "../lib/contextBuilder.js";
import { maybeSummarize } from "../lib/summarizer.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { makeSubscriptionStore } from "../lib/subscriptionStore.js";
import { validateId } from "../lib/ids.js";
import { httpErr } from "../lib/auth.js";
import { CORS } from "../lib/http.js";
import { makeActionFilter, executeAction } from "../lib/actionExecutor.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  ...CORS,
};

export async function handleCoupleChat(request, env, auth, coupleId, ctx) {
  validateId(coupleId);
  await checkRateLimit(env, auth.userId, "chat");

  let body;
  try {
    body = await request.json();
  } catch {
    throw httpErr(400, "invalid JSON");
  }
  if (!body?.message || typeof body.message !== "string")
    throw httpErr(400, "message is required");
  if (body.context !== undefined && body.context !== null && (
    typeof body.context !== "object" ||
    Array.isArray(body.context) ||
    JSON.stringify(body.context).length > 20000
  )) {
    throw httpErr(400, "context must be an object under 20KB");
  }

  // Subscription gate — throws 402 if trial exhausted and no active plan.
  await makeSubscriptionStore(env).checkAndGate(coupleId);

  const convStore = makeConversationStore(env);

  // 1. Tạo conversation nếu thiếu
  let conversationId = body.conversationId;
  let createdConv = null;
  if (conversationId) validateId(conversationId);
  else {
    createdConv = await convStore.create(coupleId, body.message.slice(0, 30));
    conversationId = createdConv.id;
  }

  // 2. Lưu user message TRƯỚC khi gọi LLM
  await convStore.appendMessage(coupleId, conversationId, {
    role: "user",
    content: body.message,
  });

  // 3. Build context (persona + agent + profile + memory + summary)
  const { systemPrompt } = await buildChatContext(
    env,
    coupleId,
    conversationId,
    body.message,
    body.context,
  );
  const { messages: recent } = await convStore.getMessages(
    coupleId,
    conversationId,
    { limit: 30 },
  );

  // 4. Orchestrator có sẵn (giữ nguyên cost-aware fallback)
  const { orchestrator } = createOrchestrator(env, { strategy: "cost_aware" });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev, data) =>
        controller.enqueue(
          encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      if (createdConv) send("conversation", createdConv);

      let assistantText = "";
      let finalMeta = null;
      let errorSent = false;
      const actionFilter = makeActionFilter();
      try {
        for await (const event of orchestrator.stream({
          messages: recent.map((m) => ({ role: m.role, content: m.content })),
          systemPrompt,
          maxTokens: body.maxTokens || 1024,
          // chỉ gửi temperature khi client set tường minh (Opus 4.7+ đã bỏ)
          temperature: body.temperature,
        })) {
          if (event.type === "chunk") {
            const { visible, actions } = actionFilter.process(event.text);
            if (visible) {
              assistantText += visible;
              send("chunk", { text: visible });
            }
            for (const action of actions) {
              try {
                const result = await executeAction(action, env, coupleId);
                send("action", result);
              } catch (e) {
                console.error("action execution failed:", e.message);
              }
            }
          } else if (event.type === "meta") {
            finalMeta = event;
            send("meta", event);
          } else if (event.type === "error") {
            errorSent = true;
            send("error", {
              message: event.mid_stream
                ? "Kết nối AI bị gián đoạn. Bạn có thể thử lại để nhận phần trả lời đầy đủ."
                : "Tơ Hồng đang gặp lỗi kết nối tạm thời. Vui lòng thử lại sau một chút.",
              recoverable: event.recoverable !== false,
            });
          }
        }
        // Flush any text buffered at stream end (e.g. incomplete marker prefix)
        const flushed = actionFilter.flush();
        if (flushed) {
          assistantText += flushed;
          send("chunk", { text: flushed });
        }
        // 5. Lưu assistant message
        await convStore.appendMessage(coupleId, conversationId, {
          role: "assistant",
          content: assistantText,
          metadata: {
            provider: finalMeta?.provider,
            model: finalMeta?.model,
            usage: finalMeta?.usage,
            partial: false,
          },
        });
        // 6. Summarize ở nền — không chặn response
        send("done", {});
        ctx.waitUntil(
          maybeSummarize(env, coupleId, conversationId).catch((e) =>
            console.error("summarize failed:", e.message),
          ),
        );
      } catch (err) {
        if (assistantText) {
          await convStore.appendMessage(coupleId, conversationId, {
            role: "assistant",
            content: assistantText,
            metadata: { partial: true },
          });
        }
        if (!errorSent) {
          send("error", {
            message: "Tơ Hồng đang gặp lỗi kết nối tạm thời. Vui lòng thử lại sau một chút.",
            recoverable: true,
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
