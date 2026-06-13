import { makeStore } from "../lib/fileStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { callLLM, parseLLMJson } from "../lib/llmHelper.js";

const docKey      = (id) => `data/couples/${id}/budget.json`;
const proposalKey = (id) => `data/couples/${id}/budget_proposal_cache.json`;
const now = () => new Date().toISOString();
const PROPOSAL_TTL = 60 * 60 * 1000; // 1h

const DEFAULT_CATEGORIES = [
  { id: "tiec", name: "Tiệc & nhà hàng", amt: 220, color: "var(--son-500)", icon: "utensils-crossed", locked: false, items: [
    { id: "wp", name: "White Palace · sảnh tiêu chuẩn", amt: 200, vendor: true },
    { id: "banc", name: "Bàn ghế & dịch vụ tiệc", amt: 20 },
  ] },
  { id: "trang", name: "Trang trí & hoa", amt: 70, color: "var(--son-300)", icon: "flower-2", locked: false, items: [
    { id: "hoa", name: "Hoa cưới & backdrop sân khấu", amt: 45, vendor: true },
    { id: "cong", name: "Cổng hoa + bàn gallery", amt: 25 },
  ] },
  { id: "chup", name: "Chụp ảnh / quay", amt: 60, color: "var(--dao-400)", icon: "camera", locked: false, items: [
    { id: "psc", name: "Phóng sự cưới (ngày cưới)", amt: 40, vendor: true },
    { id: "pre", name: "Chụp pre-wedding", amt: 20 },
  ] },
  { id: "nhan", name: "Nhẫn, tráp, lễ", amt: 60, color: "var(--kim-500)", icon: "gem", locked: false, items: [
    { id: "ring", name: "Nhẫn cưới đôi", amt: 35 },
    { id: "trap", name: "Tráp ăn hỏi · 5 tráp", amt: 15, vendor: true },
    { id: "leden", name: "Lễ đen (nạp tài)", amt: 10 },
  ] },
  { id: "trangp", name: "Trang phục", amt: 50, color: "var(--kim-300)", icon: "shirt", locked: false, items: [
    { id: "aodai", name: "Áo dài cô dâu + vest chú rể", amt: 30, vendor: true },
    { id: "vay", name: "Thuê váy cưới", amt: 20 },
  ] },
  { id: "phong", name: "Dự phòng", amt: 40, color: "var(--ink-300)", icon: "shield", locked: false, items: [] },
];

function defaultBudget() {
  return {
    categories: DEFAULT_CATEGORIES,
    total_tr: 500,
    guests: 200,
    mung_tr: 150,
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
    return jsonResponse(r?.value ?? defaultBudget());
  }

  if (method === "PUT") {
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
    if (!Array.isArray(body?.categories)) return errorResponse(400, "categories array required");
    const doc = {
      categories: body.categories,
      total_tr: typeof body.total_tr === "number" ? body.total_tr : 500,
      guests: typeof body.guests === "number" ? body.guests : 200,
      mung_tr: typeof body.mung_tr === "number" ? body.mung_tr : 150,
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
  if (cached?.value?.valid_until && new Date(cached.value.valid_until) > ts) {
    return jsonResponse(cached.value);
  }

  // Load budget + profile
  const [budgetR, profileR] = await Promise.all([
    store.getJson(docKey(coupleId)).catch(() => null),
    store.getYaml(`data/couples/${coupleId}/profile.yaml`).catch(() => null),
  ]);
  const budget  = budgetR?.value  ?? {};
  const profile = profileR?.value ?? {};

  const cats = (budget.categories ?? []).map((c) => `${c.name}: ${c.amt}tr`).join(", ");
  const month = profile.wedding_date ? new Date(profile.wedding_date).getMonth() + 1 : "?";
  const city  = profile.city || profile.location || "TP.HCM";

  const systemPrompt = `Bạn là chuyên gia phân bổ ngân sách cưới. Trả lời JSON THUẦN, không markdown.`;
  const userPrompt = `Ngân sách hiện tại (${budget.total_tr ?? 500}tr cho ${budget.guests ?? 200} khách):
${cats || "chưa có dữ liệu"}

Đám cưới tháng ${month} tại ${city}.

Đề xuất 1 tái phân bổ cụ thể, giữ nguyên tổng ${budget.total_tr ?? 500}tr.
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
  } catch {
    // Static fallback
    proposal = {
      title: "Tối ưu ngân sách theo mùa",
      blurb: "Đổi sang sảnh Grand — trần cao, sân khấu lớn, đủ chỗ cho 200 khách thoải mái.",
      delta: 30,
      changes: [
        { id: "tiec",  label: "Tiệc & nhà hàng", from: 220, to: 250 },
        { id: "phong", label: "Dự phòng",         from: 40,  to: 10  },
      ],
      note: "Tổng vẫn không đổi — lấy từ Dự phòng. Tiền mừng dự kiến vẫn dư sức bù.",
    };
  }

  const doc = {
    ...proposal,
    generated_at: ts.toISOString(),
    valid_until: new Date(ts.getTime() + PROPOSAL_TTL).toISOString(),
  };
  await store.putJson(proposalKey(coupleId), doc).catch(() => {});

  return jsonResponse(doc);
}
