import { makeStore } from "../lib/fileStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { callLLM, parseLLMJson } from "../lib/llmHelper.js";

const docKey      = (id) => `data/couples/${id}/budget.json`;
const proposalKey = (id) => `data/couples/${id}/budget_proposal_cache.json`;
const now = () => new Date().toISOString();
const PROPOSAL_TTL = 60 * 60 * 1000; // 1h

function toMillions(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 10000 ? Math.round(value / 1_000_000) : Math.round(value);
  }
  if (typeof value !== "string") return 0;
  const amount = Number(value.replace(/[^\d]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount >= 10000 ? Math.round(amount / 1_000_000) : Math.round(amount);
}

async function defaultBudget(store, coupleId) {
  const profileDoc = (
    await store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null)
  )?.value ?? {};
  const profile = profileDoc.couple ?? profileDoc;
  return {
    categories: [],
    total_tr: toMillions(profile.budget_vnd),
    guests: Math.max(0, parseInt(profile.guest_count, 10) || 0),
    mung_tr: 0,
    updated_at: null,
  };
}

export async function handleBudget(request, env, auth, coupleId, tail) {
  validateId(coupleId);
  const method = request.method;
  const store = makeStore(env);

  // GET /budget/proposal
  if (tail === "proposal") {
    if (method !== "GET") return errorResponse(405, "method not allowed");
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    return handleBudgetProposal(env, store, coupleId);
  }

  if (method === "GET") {
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    const r = await store.getJson(docKey(coupleId));
    return jsonResponse(r?.value ?? await defaultBudget(store, coupleId));
  }

  if (method === "PUT") {
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
    if (!Array.isArray(body?.categories)) return errorResponse(400, "categories array required");
    const doc = {
      categories: body.categories,
      total_tr: typeof body.total_tr === "number" ? Math.max(0, body.total_tr) : 0,
      guests: typeof body.guests === "number" ? Math.max(0, body.guests) : 0,
      mung_tr: typeof body.mung_tr === "number" ? Math.max(0, body.mung_tr) : 0,
      updated_at: now(),
    };
    await store.putJson(docKey(coupleId), doc);
    return jsonResponse(doc);
  }

  return errorResponse(405, "method not allowed");
}

async function handleBudgetProposal(env, store, coupleId) {
  const ts = new Date();

  // Serve from cache if still fresh
  const cached = await store.getJson(proposalKey(coupleId)).catch(() => null);
  if (
    cached?.value?.source === "ai" &&
    cached.value.valid_until &&
    new Date(cached.value.valid_until) > ts
  ) {
    return jsonResponse(cached.value);
  }

  // Load budget + profile
  const [budgetR, profileR] = await Promise.all([
    store.getJson(docKey(coupleId)).catch(() => null),
    store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null),
  ]);
  const budget = budgetR?.value ?? await defaultBudget(store, coupleId);
  const profileDoc = profileR?.value ?? {};
  const profile = profileDoc.couple ?? profileDoc;
  const categories = budget.categories ?? [];
  const allocatedTotal = categories.reduce((sum, category) => sum + (Number(category.amt) || 0), 0);

  if (!categories.length || allocatedTotal <= 0 || !budget.total_tr) {
    return errorResponse(422, "insufficient_budget_data");
  }

  const cats = categories.map((c) => `${c.id} | ${c.name}: ${c.amt}tr`).join(", ");
  const month = profile.wedding_date ? new Date(profile.wedding_date).getMonth() + 1 : "?";
  const city  = profile.city || profile.location || "chưa xác định";

  const systemPrompt = `Bạn là chuyên gia phân bổ ngân sách cưới. Trả lời JSON THUẦN, không markdown.`;
  const userPrompt = `Ngân sách hiện tại (${budget.total_tr}tr${budget.guests ? ` cho ${budget.guests} khách` : ", chưa có số khách"}):
${cats}

Đám cưới tháng ${month} tại ${city}.

Đề xuất 1 tái phân bổ cụ thể, giữ nguyên tổng đã phân bổ ${allocatedTotal}tr và không tự tạo vendor.
Trả về JSON theo đúng schema này:
{
  "title": "chuỗi ngắn",
  "blurb": "mô tả 1 câu",
  "delta": số_tr_thay_đổi_lớn_nhất,
  "changes": [{ "id": "id_cat", "label": "tên", "from": số, "to": số }],
  "note": "ghi chú ngắn cho cặp đôi"
}`;

  let proposal;
  try {
    const text = await callLLM(env, { systemPrompt, userPrompt, maxTokens: 512 });
    proposal = parseLLMJson(text);
    if (!proposal?.title || !Array.isArray(proposal?.changes)) throw new Error("invalid schema");
    const byId = new Map(categories.map((category) => [category.id, category]));
    const seen = new Set();
    const changes = proposal.changes.map((change) => {
      const category = byId.get(change.id);
      const to = Number(change.to);
      if (!category || seen.has(change.id) || !Number.isFinite(to) || to < 0) {
        throw new Error("invalid budget change");
      }
      seen.add(change.id);
      return {
        id: category.id,
        label: category.name,
        from: Number(category.amt) || 0,
        to,
      };
    });
    if (!changes.length) throw new Error("empty budget changes");
    const changedById = new Map(changes.map((change) => [change.id, change.to]));
    const proposedTotal = categories.reduce(
      (sum, category) => sum + (changedById.get(category.id) ?? (Number(category.amt) || 0)),
      0,
    );
    if (Math.abs(proposedTotal - allocatedTotal) > 0.01) {
      throw new Error("proposal changes allocated total");
    }
    proposal = {
      title: String(proposal.title).trim(),
      blurb: String(proposal.blurb || "").trim(),
      delta: Math.max(...changes.map((change) => Math.abs(change.to - change.from))),
      changes,
      note: String(proposal.note || "").trim(),
    };
  } catch (error) {
    console.error("budget proposal AI generation failed:", error.message);
    return errorResponse(502, "ai_generation_failed");
  }

  const doc = {
    ...proposal,
    generated_at: ts.toISOString(),
    valid_until: new Date(ts.getTime() + PROPOSAL_TTL).toISOString(),
    source: "ai",
  };
  await store.putJson(proposalKey(coupleId), doc).catch(() => {});

  return jsonResponse(doc);
}
