import { makeStore } from "../lib/fileStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { callLLM, parseLLMJson } from "../lib/llmHelper.js";
import { makeSubscriptionStore } from "../lib/subscriptionStore.js";
import YAML from "yaml";

const cacheKey  = (id) => `data/couples/${id}/briefing/today.json`;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function loadContext(store, coupleId) {
  const [profileR, budgetR, timelineR, guestsR] = await Promise.all([
    store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null),
    store.getJson(`data/couples/${coupleId}/budget.json`).catch(() => null),
    store.getJson(`data/couples/${coupleId}/timeline.json`).catch(() => null),
    store.getJson(`data/couples/${coupleId}/guests.json`).catch(() => null),
  ]);

  const profile  = profileR?.value  ?? {};
  const budget   = budgetR?.value   ?? {};
  const timeline = timelineR?.value ?? {};
  const guests   = guestsR?.value   ?? {};

  // Days until wedding
  let daysLeft = null;
  if (profile.wedding_date) {
    daysLeft = Math.ceil((new Date(profile.wedding_date) - new Date()) / (1000 * 60 * 60 * 24));
  }

  // Timeline summary
  const allTasks = (timeline.phases ?? []).flatMap((p) => p.tasks ?? []);
  const pendingTasks = allTasks.filter((t) => !t.done).map((t) => t.text || t.label).slice(0, 5);

  // Budget summary
  const spent = (budget.categories ?? []).reduce((s, c) => s + (c.amt || 0), 0);
  const overBudget = budget.total_tr && spent > budget.total_tr;

  // Guests
  const guestList = guests.guests ?? [];
  const pendingGuests = guestList.filter((g) => g.status === "pending").length;

  return { profile, daysLeft, pendingTasks, overBudget, spent, total_tr: budget.total_tr, pendingGuests };
}

export async function handleBriefing(request, env, auth, coupleId) {
  validateId(coupleId);
  if (request.method !== "GET") return errorResponse(405, "method not allowed");
  await requireCoupleAccess(env, auth.userId, coupleId, "read");

  // Subscription: briefing available to active plan or in-trial users
  const sub = await makeSubscriptionStore(env).get(coupleId);
  const now = new Date();
  const hasAccess =
    (sub.plan && sub.status === "active" && sub.expires_at && new Date(sub.expires_at) > now) ||
    sub.trial_messages_used > 0; // only after they've started using the app

  if (!hasAccess) {
    return errorResponse(402, "subscription_required");
  }

  const store = makeStore(env);

  // Serve from cache if fresh
  const cached = await store.getJson(cacheKey(coupleId)).catch(() => null);
  if (cached?.value?.valid_until && new Date(cached.value.valid_until) > now) {
    return jsonResponse(cached.value);
  }

  // Build context and call LLM
  const ctx = await loadContext(store, coupleId);
  const { profile, daysLeft, pendingTasks, overBudget, pendingGuests } = ctx;

  const systemPrompt = `Bạn là trợ lý cưới Tơ Hồng. Trả lời DẠNG JSON THUẦN, không markdown.`;
  const userPrompt = `Cặp đôi: ${profile.bride_name || "cô dâu"} & ${profile.groom_name || "chú rể"}.
Ngày cưới: ${profile.wedding_date || "chưa xác định"}. Còn ${daysLeft ?? "?"} ngày.
Việc chuẩn bị chưa xong: ${pendingTasks.length ? pendingTasks.join(", ") : "không có"}.
Khách chưa xác nhận: ${pendingGuests} người.
Ngân sách: ${overBudget ? `vượt mức (đã chi ${ctx.spent}tr / tổng ${ctx.total_tr}tr)` : "cân đối"}.

Liệt kê TỐI ĐA 3 việc quan trọng nhất họ cần làm TUẦN NÀY.
Trả về JSON array of strings. Ngắn gọn, action-oriented, tiếng Việt.
Ví dụ: ["Chốt menu với bếp trước 13.09", "Nhắn nhắc 18 khách chưa xác nhận", "Thử áo dài lần 2"]`;

  let items;
  try {
    const text = await callLLM(env, { systemPrompt, userPrompt, maxTokens: 256 });
    items = parseLLMJson(text);
    if (!Array.isArray(items)) throw new Error("not an array");
    items = items.slice(0, 3).map(String);
  } catch {
    // Fall back to generic items if LLM fails or parse fails
    items = pendingTasks.slice(0, 3).length
      ? pendingTasks.slice(0, 3)
      : ["Kiểm tra tiến độ chuẩn bị cưới", "Liên hệ nhà cung cấp dịch vụ", "Xác nhận danh sách khách"];
  }

  const generated_at = now.toISOString();
  const valid_until  = new Date(now.getTime() + CACHE_TTL).toISOString();
  const doc = { items, generated_at, valid_until };

  await store.putJson(cacheKey(coupleId), doc).catch(() => {});

  return jsonResponse(doc);
}
