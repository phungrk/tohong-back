import { makeGuestStore } from "./guestStore.js";
import { makeStore } from "./fileStore.js";

export const ACTION_START = "<<<ACTION_START>>>";
export const ACTION_END = "<<<ACTION_END>>>";

// Injected into every chat system prompt — teaches the AI how to trigger mutations.
export const ACTION_SYSTEM_PROMPT = `## THỰC HIỆN HÀNH ĐỘNG TRONG APP

Khi user yêu cầu THỰC HIỆN hành động thêm/sửa/xóa dữ liệu, hãy:
1. Xác nhận bằng tiếng Việt tự nhiên (theo OUTPUT FORMAT đã quy định)
2. Đặt JSON action ở CUỐI response, sau toàn bộ text xác nhận:

<<<ACTION_START>>>
{"type":"add_guest","name":"Tên khách","side":"trai","count":1}
<<<ACTION_END>>>

Các action type được hỗ trợ:

| Type | Fields bắt buộc | Fields tuỳ chọn |
|------|----------------|-----------------|
| add_guest | name, side ("trai"/"gai") | count (số suất, mặc định 1), phone, note |
| add_budget_item | category_name, name, amount_tr | — |
| add_checklist_task | text | phase (tên giai đoạn, vd "Chuẩn bị") |
| update_guest_status | name (tên hoặc một phần), status ("yes"/"no"/"pending") | — |

Ví dụ — "thêm MC tiệc cưới 5 triệu":
Mình đã thêm MC vào ngân sách rồi nhé!
<<<ACTION_START>>>
{"type":"add_budget_item","category_name":"MC & Âm thanh","name":"MC tiệc cưới","amount_tr":5}
<<<ACTION_END>>>

QUY TẮC:
- CHỈ thêm action khi user YÊU CẦU thực hiện hành động (không phải hỏi, tư vấn, hay gợi ý)
- side phải là "trai" (nhà trai) hoặc "gai" (nhà gái), không dùng bride/groom
- KHÔNG thêm bất kỳ text nào sau <<<ACTION_END>>>
- Mỗi response chỉ có tối đa 1 action block`;

/**
 * Streaming filter — intercepts <<<ACTION_START>>>...<<<ACTION_END>>> blocks
 * from the raw LLM text stream. Visible text is forwarded to the client;
 * action JSON is extracted for server-side execution.
 *
 * Usage:
 *   const filter = makeActionFilter();
 *   for each chunk: const { visible, actions } = filter.process(chunk);
 *   after stream:   const leftover = filter.flush();
 */
export function makeActionFilter() {
  const state = { inBlock: false, blockBuf: "", pending: "" };

  function process(chunk) {
    const visibleParts = [];
    const actions = [];
    state.pending += chunk;

    while (state.pending.length > 0) {
      if (state.inBlock) {
        const endIdx = state.pending.indexOf(ACTION_END);
        if (endIdx !== -1) {
          state.blockBuf += state.pending.slice(0, endIdx);
          try {
            actions.push(JSON.parse(state.blockBuf.trim()));
          } catch {
            // Malformed JSON — skip silently
          }
          state.blockBuf = "";
          state.inBlock = false;
          state.pending = state.pending.slice(endIdx + ACTION_END.length);
        } else {
          // End marker not yet fully received — buffer and wait
          state.blockBuf += state.pending;
          state.pending = "";
        }
      } else {
        const startIdx = state.pending.indexOf(ACTION_START);
        if (startIdx !== -1) {
          visibleParts.push(state.pending.slice(0, startIdx));
          state.inBlock = true;
          state.blockBuf = "";
          state.pending = state.pending.slice(startIdx + ACTION_START.length);
        } else {
          // No start marker — but the tail might be an incomplete prefix.
          // Find the LONGEST suffix of pending that is a prefix of ACTION_START and buffer it.
          let safeCut = state.pending.length;
          for (let i = ACTION_START.length - 1; i >= 1; i--) {
            if (state.pending.endsWith(ACTION_START.slice(0, i))) {
              safeCut = state.pending.length - i;
              break;
            }
          }
          visibleParts.push(state.pending.slice(0, safeCut));
          state.pending = state.pending.slice(safeCut);
          break;
        }
      }
    }

    return { visible: visibleParts.join(""), actions };
  }

  function flush() {
    // End of stream: any buffered pending that isn't inside an action block
    // gets released as visible text.  Incomplete action blocks are discarded.
    if (state.inBlock) {
      state.inBlock = false;
      state.blockBuf = "";
    }
    const leftover = state.pending;
    state.pending = "";
    return leftover;
  }

  return { process, flush };
}

/**
 * Execute a single parsed action object against the couple's data stores.
 * Returns { type, success, data? } — never throws (errors are returned as success:false).
 */
export async function executeAction(action, env, coupleId) {
  const type = action?.type;

  if (type === "add_guest") {
    const gs = makeGuestStore(env);
    const side = action.side === "gai" ? "gai" : "trai";
    const guest = await gs.add(coupleId, {
      name: action.name,
      side,
      count: action.count || 1,
      phone: action.phone || null,
      note: action.note || null,
    });
    return { type, success: true, data: guest };
  }

  if (type === "update_guest_status") {
    const gs = makeGuestStore(env);
    const doc = await gs.get(coupleId);
    if (!doc?.guests?.length) {
      return { type, success: false, error: "Chưa có danh sách khách." };
    }
    const needle = (action.name || "").toLowerCase();
    const guest = doc.guests.find(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        needle.includes(g.name.toLowerCase()),
    );
    if (!guest) {
      return { type, success: false, error: `Không tìm thấy khách "${action.name}".` };
    }
    await gs.update(coupleId, guest.id, { status: action.status });
    return { type, success: true, data: { id: guest.id, name: guest.name, status: action.status } };
  }

  if (type === "add_budget_item") {
    const store = makeStore(env);
    const key = `data/couples/${coupleId}/budget.json`;
    const r = await store.getJson(key);
    const budget = r?.value || {
      total_tr: 500,
      guests: 200,
      mung_tr: 150,
      categories: [],
      updated_at: null,
    };

    const catNeedle = (action.category_name || "").toLowerCase();
    let cat = budget.categories.find(
      (c) =>
        c.name.toLowerCase().includes(catNeedle) ||
        catNeedle.includes(c.name.toLowerCase()),
    );

    if (!cat) {
      cat = {
        id: "c" + Date.now().toString(36),
        name: action.category_name,
        amt: 0,
        color: "var(--dao-400)",
        icon: "store",
        locked: false,
        items: [],
      };
      budget.categories.push(cat);
    }

    cat.items = cat.items || [];
    cat.items.push({
      id: "i" + Date.now().toString(36),
      name: action.name,
      amt: action.amount_tr || 0,
      vendor: true,
    });
    cat.amt = cat.items.reduce((s, it) => s + (it.amt || 0), 0);
    budget.updated_at = new Date().toISOString();

    await store.putJson(key, budget);
    return {
      type,
      success: true,
      data: { category: cat.name, name: action.name, amt: action.amount_tr },
    };
  }

  if (type === "add_checklist_task") {
    const store = makeStore(env);
    const key = `data/couples/${coupleId}/timeline.json`;
    const r = await store.getJson(key);
    const timeline = r?.value || { phases: [], rundown: [] };

    const phaseLower = (action.phase || "").toLowerCase();
    let phase = phaseLower
      ? timeline.phases.find((p) => p.label.toLowerCase().includes(phaseLower))
      : null;
    phase =
      phase ||
      timeline.phases.find((p) => p.status === "in_progress") ||
      timeline.phases[0];

    if (phase) {
      phase.tasks = phase.tasks || [];
      phase.tasks.push({
        id: "t" + Date.now().toString(36),
        text: action.text,
        done: false,
      });
    } else {
      timeline.phases.push({
        id: "p" + Date.now().toString(36),
        label: "Cần làm",
        status: "in_progress",
        tasks: [{ id: "t" + Date.now().toString(36), text: action.text, done: false }],
      });
    }

    await store.putJson(key, timeline);
    return { type, success: true, data: { text: action.text } };
  }

  return { type, success: false, error: `Action type "${type}" không được hỗ trợ.` };
}
