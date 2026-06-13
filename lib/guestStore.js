import { makeStore } from "./fileStore.js";
import { newGuestId, validateId } from "./ids.js";
import { httpErr } from "./auth.js";

const now = () => new Date().toISOString();
const docKey = (id) => `data/couples/${id}/guests.json`;

function calcSummary(guests) {
  const s = { yes: 0, pending: 0, no: 0, total: 0 };
  for (const g of guests) {
    const n = g.count || 1;
    s.total += n;
    if (s[g.status] !== undefined) s[g.status] += n;
  }
  return s;
}

export function makeGuestStore(env) {
  const store = makeStore(env);

  const getDoc = async (coupleId) => {
    const r = await store.getJson(docKey(coupleId));
    return r?.value || null;
  };

  const saveDoc = (coupleId, doc) =>
    store.putJson(docKey(coupleId), { ...doc, updated_at: now() });

  return {
    async get(coupleId) {
      validateId(coupleId);
      const doc = await getDoc(coupleId);
      if (!doc) return null;
      return { ...doc, summary: calcSummary(doc.guests || []) };
    },

    async add(coupleId, input) {
      validateId(coupleId);
      const doc = (await getDoc(coupleId)) || { capacity: 200, guests: [] };
      const guest = {
        id: newGuestId(),
        name: (input.name || "Khách mới").slice(0, 80),
        side: ["trai", "gai"].includes(input.side) ? input.side : "trai",
        status: "pending",
        count: Math.max(1, parseInt(input.count) || 1),
        role: (input.role || "Bạn bè").slice(0, 40),
        created_at: now(),
      };
      doc.guests.push(guest);
      await saveDoc(coupleId, doc);
      return guest;
    },

    async update(coupleId, guestId, patch) {
      validateId(coupleId);
      const doc = await getDoc(coupleId);
      if (!doc) throw httpErr(404, "guests not found");
      const idx = doc.guests.findIndex((g) => g.id === guestId);
      if (idx === -1) throw httpErr(404, "guest not found");
      const cur = doc.guests[idx];
      const allowed = {};
      if (patch.name !== undefined) allowed.name = String(patch.name).slice(0, 80);
      if (patch.status !== undefined) {
        if (!["yes", "pending", "no"].includes(patch.status))
          throw httpErr(400, "status must be yes|pending|no");
        allowed.status = patch.status;
      }
      if (patch.count !== undefined) allowed.count = Math.max(1, parseInt(patch.count) || 1);
      if (patch.role !== undefined) allowed.role = String(patch.role).slice(0, 40);
      if (patch.side !== undefined && ["trai", "gai"].includes(patch.side))
        allowed.side = patch.side;
      doc.guests[idx] = { ...cur, ...allowed, updated_at: now() };
      await saveDoc(coupleId, doc);
      return doc.guests[idx];
    },

    async remove(coupleId, guestId) {
      validateId(coupleId);
      const doc = await getDoc(coupleId);
      if (!doc) throw httpErr(404, "guests not found");
      const before = doc.guests.length;
      doc.guests = doc.guests.filter((g) => g.id !== guestId);
      if (doc.guests.length === before) throw httpErr(404, "guest not found");
      await saveDoc(coupleId, doc);
      return { ok: true };
    },

    async updateCapacity(coupleId, capacity) {
      validateId(coupleId);
      const doc = (await getDoc(coupleId)) || { guests: [] };
      doc.capacity = Math.max(1, parseInt(capacity) || 200);
      await saveDoc(coupleId, doc);
      return { capacity: doc.capacity };
    },

    getDoc,
  };
}
