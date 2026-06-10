import { makeStore } from "../lib/fileStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { callLLM, parseLLMJson } from "../lib/llmHelper.js";

const docKey        = (id) => `data/couples/${id}/timeline.json`;
const suggestKey    = (id) => `data/couples/${id}/timeline_suggestions_cache.json`;
const now = () => new Date().toISOString();
const SUGGEST_TTL   = 12 * 60 * 60 * 1000; // 12h

const DEFAULT_PHASES = [
  { id: "ph1", label: "Đã xong · -12 tuần", status: "done", tasks: [
    { id: "pt01", text: "Chốt nhà hàng & đặt cọc", done: true },
    { id: "pt02", text: "Đặt hoa cưới & trang trí", done: true },
  ] },
  { id: "ph2", label: "Đã xong · -8 tuần", status: "done", tasks: [
    { id: "pt03", text: "Gửi thiệp mời đợt 1", done: true },
    { id: "pt04", text: "Thử áo dài lần 1", done: true },
  ] },
  { id: "ph3", label: "Tuần này · đến 13.09", status: "current", tasks: [
    { id: "pt05", text: "Chốt menu với bếp", done: false },
    { id: "pt06", text: "Tổng duyệt với MC", done: false },
    { id: "pt07", text: "Xác nhận band nhạc", done: false },
  ] },
  { id: "ph4", label: "2 tuần nữa · đến 27.09", status: "upcoming", tasks: [
    { id: "pt08", text: "Gửi thiệp nhắc đợt 2", done: false },
    { id: "pt09", text: "Sơ đồ bàn tiệc", done: false },
  ] },
  { id: "ph5", label: "Ngày N-1 · 11.10", status: "upcoming", tasks: [
    { id: "pt10", text: "Kiểm tra hoa & trang trí", done: false },
    { id: "pt11", text: "Dọn phòng cô dâu", done: false },
  ] },
];

const DEFAULT_RUNDOWN = [
  { id: "r1", time: "08:30", name: "Đón dâu tại nhà gái", tag: "Lễ", done: true },
  { id: "r2", time: "09:30", name: "Lễ gia tiên", tag: "Lễ", done: true },
  { id: "r3", time: "10:30", name: "Di chuyển đến nhà hàng", tag: "Di chuyển", done: false, nudge: true },
  { id: "r4", time: "11:00", name: "Đón khách · welcome", tag: "Tiệc", done: false },
  { id: "r5", time: "11:30", name: "Nghi lễ sân khấu", tag: "Tiệc", done: false },
  { id: "r6", time: "12:00", name: "Khai tiệc · nâng ly", tag: "Tiệc", done: false },
  { id: "r7", time: "13:30", name: "Tiễn khách", tag: "Tiệc", done: false },
];

function defaultTimeline() {
  return {
    phases: DEFAULT_PHASES,
    rundown: DEFAULT_RUNDOWN,
    updated_at: null,
  };
}

export async function handleTimeline(request, env, auth, coupleId, tail) {
  validateId(coupleId);
  const method = request.method;
  const store = makeStore(env);

  // GET /timeline/suggestions
  if (tail === "suggestions") {
    if (method !== "GET") return errorResponse(405, "method not allowed");
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    return handleTimelineSuggestions(env, store, coupleId);
  }

  if (method === "GET") {
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    const r = await store.getJson(docKey(coupleId));
    return jsonResponse(r?.value ?? defaultTimeline());
  }

  if (method === "PUT") {
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
    if (!Array.isArray(body?.phases) || !Array.isArray(body?.rundown))
      return errorResponse(400, "phases and rundown arrays required");
    const doc = {
      phases: body.phases,
      rundown: body.rundown,
      updated_at: now(),
    };
    await store.putJson(docKey(coupleId), doc);
    return jsonResponse(doc);
  }

  return errorResponse(405, "method not allowed");
}

async function handleTimelineSuggestions(env, store, coupleId) {
  const ts = new Date();

  // Serve from cache if fresh
  const cached = await store.getJson(suggestKey(coupleId)).catch(() => null);
  if (cached?.value?.valid_until && new Date(cached.value.valid_until) > ts) {
    return jsonResponse(cached.value);
  }

  // Load timeline + profile
  const [timelineR, profileR] = await Promise.all([
    store.getJson(docKey(coupleId)).catch(() => null),
    store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null),
  ]);
  const timeline = timelineR?.value ?? {};
  const profile  = profileR?.value  ?? {};

  let daysLeft = null;
  if (profile.wedding_date) {
    daysLeft = Math.ceil((new Date(profile.wedding_date) - ts) / (1000 * 60 * 60 * 24));
  }

  const rundown = (timeline.rundown ?? [])
    .map((r) => `${r.time} ${r.name ?? r.label}`)
    .join(", ");

  const systemPrompt = `Bạn là chuyên gia tổ chức tiệc cưới Việt Nam. Trả lời JSON THUẦN, không markdown.`;
  const userPrompt = `Lịch trình ngày cưới hiện tại: ${rundown || "chưa có dữ liệu"}.
Còn ${daysLeft ?? "?"} ngày đến ngày cưới.

Có task nào bị thiếu trong rundown không? Trả tối đa 2 gợi ý thêm vào.
Trả JSON array theo đúng schema:
[{ "id": "s1", "time": "HH:MM", "label": "tên task", "reason": "lý do ngắn" }]`;

  let suggestions;
  try {
    const text = await callLLM(env, { systemPrompt, userPrompt, maxTokens: 384 });
    suggestions = parseLLMJson(text);
    if (!Array.isArray(suggestions)) throw new Error("not an array");
    suggestions = suggestions.slice(0, 2);
  } catch {
    // Static fallback — most common missing buffer
    suggestions = [{
      id: "s1",
      time: "10:45",
      label: "Buffer di chuyển → nhà hàng",
      reason: "Khoảng cách di chuyển → đón khách chỉ 30 phút có thể ngắn nếu kẹt xe.",
    }];
  }

  const doc = {
    suggestions,
    generated_at: ts.toISOString(),
    valid_until: new Date(ts.getTime() + SUGGEST_TTL).toISOString(),
  };
  await store.putJson(suggestKey(coupleId), doc).catch(() => {});

  return jsonResponse(doc);
}
