import { makeStore } from "../lib/fileStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { callLLM, parseLLMJson } from "../lib/llmHelper.js";

const docKey        = (id) => `data/couples/${id}/timeline.json`;
const suggestKey    = (id) => `data/couples/${id}/timeline_suggestions_cache.json`;
const now = () => new Date().toISOString();
const SUGGEST_TTL   = 12 * 60 * 60 * 1000; // 12h

function defaultTimeline() {
  return {
    phases: [{ id: "ph_current", label: "Việc cần làm", status: "current", tasks: [] }],
    rundown: [],
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
  if (
    cached?.value?.source === "ai" &&
    cached.value.valid_until &&
    new Date(cached.value.valid_until) > ts
  ) {
    return jsonResponse(cached.value);
  }

  // Load timeline + profile
  const [timelineR, profileR] = await Promise.all([
    store.getJson(docKey(coupleId)).catch(() => null),
    store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null),
  ]);
  const timeline = timelineR?.value ?? {};
  const profileDoc = profileR?.value ?? {};
  const profile = profileDoc.couple ?? profileDoc;

  let daysLeft = null;
  if (profile.wedding_date) {
    daysLeft = Math.ceil((new Date(profile.wedding_date) - ts) / (1000 * 60 * 60 * 24));
  }

  const rundown = (timeline.rundown ?? [])
    .map((r) => `${r.time} ${r.name ?? r.label}`)
    .join(", ");

  if (!rundown) {
    return errorResponse(422, "insufficient_timeline_data");
  }

  const systemPrompt = `Bạn là chuyên gia tổ chức tiệc cưới Việt Nam. Trả lời JSON THUẦN, không markdown.`;
  const userPrompt = `Lịch trình ngày cưới hiện tại: ${rundown || "chưa có dữ liệu"}.
Còn ${daysLeft ?? "?"} ngày đến ngày cưới.

Có task nào bị thiếu trong rundown không? Trả tối đa 2 gợi ý thêm vào.
Trả JSON array theo đúng schema:
	[{ "id": "s1", "time": "HH:MM", "label": "tên task", "tag": "Lễ|Tiệc|Di chuyển", "reason": "lý do ngắn" }]`;

  let suggestions;
  try {
    const text = await callLLM(env, { systemPrompt, userPrompt, maxTokens: 384 });
    suggestions = parseLLMJson(text);
    if (!Array.isArray(suggestions)) throw new Error("not an array");
    suggestions = suggestions.slice(0, 2).map((suggestion, index) => {
      const time = String(suggestion?.time || "");
      const label = String(suggestion?.label || "").trim();
      const reason = String(suggestion?.reason || "").trim();
      const tag = ["Lễ", "Tiệc", "Di chuyển"].includes(suggestion?.tag)
        ? suggestion.tag
        : "Tiệc";
      if (!/^\d{2}:\d{2}$/.test(time) || !label || !reason) {
        throw new Error("invalid timeline suggestion");
      }
      return { id: `ai_${index + 1}`, time, label, tag, reason };
    });
  } catch (error) {
    console.error("timeline suggestion AI generation failed:", error.message);
    return errorResponse(502, "ai_generation_failed");
  }

  const doc = {
    suggestions,
    generated_at: ts.toISOString(),
    valid_until: new Date(ts.getTime() + SUGGEST_TTL).toISOString(),
    source: "ai",
  };
  await store.putJson(suggestKey(coupleId), doc).catch(() => {});

  return jsonResponse(doc);
}
