import { makeStore } from "./fileStore.js";
import { classifyDomains } from "./router.js";
import { ORCHESTRATOR_PERSONA, AGENT_BLOCKS } from "./prompts.js";
import { ACTION_SYSTEM_PROMPT } from "./actionExecutor.js";

export async function buildChatContext(env, coupleId, conversationId, userMessage, turnContext = null) {
  const store = makeStore(env);
  const base = `data/couples/${coupleId}`;

  const profile = (await store.getYaml(`${base}/profile.yaml`))?.value || {};
  const memory = (await store.getYaml(`${base}/memory.yaml`))?.value || {};
  const summary = conversationId
    ? (await store.getText(`${base}/conversations/${conversationId}/summary.md`))
        ?.value || ""
    : "";

  const domains = classifyDomains(userMessage);
  const agentBlocks = domains.map((d) => AGENT_BLOCKS[d]).filter(Boolean);

  // Fallback: domains rỗng → chỉ persona, không gắn agent block.
  const systemPrompt = [
    ORCHESTRATOR_PERSONA,
    ACTION_SYSTEM_PROMPT,
    ...agentBlocks,
    `## Hồ sơ cặp đôi\n${JSON.stringify(profile, null, 2)}`,
    memory.facts?.length || memory.decisions?.length
      ? `## Ghi nhớ\n${JSON.stringify(memory, null, 2)}`
      : "",
    summary ? `## Tóm tắt cuộc trò chuyện\n${summary}` : "",
    turnContext
      ? `## Dữ liệu ứng dụng cho lượt hiện tại
${JSON.stringify(turnContext, null, 2)}

Dựa trực tiếp vào dữ liệu này như một wedding planner. Trả lời 2-4 câu ngắn: tóm tắt tình hình, chỉ ra điểm cần chú ý và ưu tiên tiếp theo. Không bịa dữ liệu còn thiếu, không lặp lại toàn bộ con số, không tạo bảng.`
      : "",
    `## Quy tắc dữ liệu
Chỉ khẳng định tên vendor, giá, đánh giá, lịch trống và trạng thái khi chúng xuất hiện trong hồ sơ hoặc dữ liệu ứng dụng. Nếu thiếu dữ liệu, nói rõ là chưa có dữ liệu thay vì tự tạo ví dụ có vẻ như dữ liệu thật.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, domains };
}
