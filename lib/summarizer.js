import { makeConversationStore } from "./conversationStore.js";
import { makeStore } from "./fileStore.js";
import { createOrchestrator } from "./factory.js";

const TRIGGER_EVERY = 12;

// Gọi sau khi đã lưu assistant message. Truyền Promise này vào ctx.waitUntil().
export async function maybeSummarize(env, coupleId, conversationId) {
  const convStore = makeConversationStore(env);
  const meta = await convStore.getMeta(coupleId, conversationId);
  const since =
    (meta.message_count || 0) - (meta.last_summarized_message_count || 0);
  if (since < TRIGGER_EVERY) return; // chưa tới ngưỡng
  await summarizeConversation(env, coupleId, conversationId, meta.message_count);
}

export async function summarizeConversation(
  env,
  coupleId,
  conversationId,
  atMessageCount,
) {
  const convStore = makeConversationStore(env);
  const { messages } = await convStore.getMessages(coupleId, conversationId, {
    limit: 200,
  });

  const { orchestrator } = createOrchestrator(env, {
    strategy: "cost_aware",
    tierForFallbacks: "budget",
    // Tóm tắt là việc nền, đơn giản → dùng Haiku cho rẻ, bất kể CLAUDE_MODEL.
    models: { claude: "claude-haiku-4-5-20251001" },
  });
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

  let summary = "";
  for await (const ev of orchestrator.stream({
    systemPrompt:
      "Bạn tóm tắt hội thoại tư vấn cưới thành tiếng Việt ngắn gọn, giữ lại quyết định đã chốt và việc còn dang dở.",
    messages: [
      {
        role: "user",
        content: `Tóm tắt cuộc trò chuyện sau, kèm mục "Câu hỏi còn mở":\n\n${transcript}`,
      },
    ],
    maxTokens: 600,
  })) {
    if (ev.type === "chunk") summary += ev.text;
  }

  const base = `data/couples/${coupleId}/conversations/${conversationId}`;
  await makeStore(env).putText(`${base}/summary.md`, summary);

  // Chỉ cập nhật mốc khi đã ghi summary thành công → lỗi giữa chừng thì
  // trigger sau (message kế tiếp vượt ngưỡng) sẽ thử lại.
  await convStore.update(coupleId, conversationId, {
    last_summarized_message_count: atMessageCount,
    summary_updated_at: new Date().toISOString(),
  });
}
