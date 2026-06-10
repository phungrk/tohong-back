import { makeStore } from "./fileStore.js";
import { httpErr } from "./auth.js";

const docKey = (id) => `data/couples/${id}/subscription.json`;
const now = () => new Date().toISOString();

const PLAN_DAYS = { m1: 30, m3: 90, m6: 180, m12: 365 };

function defaultDoc() {
  return {
    plan: null,
    status: "trial",
    trial_messages_used: 0,
    trial_messages_total: 3,
    trial_extended: false,
    started_at: null,
    expires_at: null,
    updated_at: now(),
  };
}

export function makeSubscriptionStore(env) {
  const store = makeStore(env);

  async function read(coupleId) {
    const r = await store.getJson(docKey(coupleId));
    return r ? r.value : defaultDoc();
  }

  async function write(coupleId, doc) {
    doc.updated_at = now();
    await store.putJson(docKey(coupleId), doc);
    return doc;
  }

  return {
    get: (coupleId) => read(coupleId),

    async activate(coupleId, plan) {
      if (!PLAN_DAYS[plan]) throw httpErr(400, "invalid plan — use m1 m3 m6 m12");
      const doc = await read(coupleId);
      const start = new Date();
      const expires = new Date(start);
      expires.setDate(expires.getDate() + PLAN_DAYS[plan]);
      doc.plan = plan;
      doc.status = "active";
      doc.started_at = start.toISOString();
      doc.expires_at = expires.toISOString();
      return write(coupleId, doc);
    },

    async extendTrial(coupleId) {
      const doc = await read(coupleId);
      if (doc.trial_extended) throw httpErr(409, "trial already extended");
      doc.trial_extended = true;
      return write(coupleId, doc);
    },

    async incrementTrial(coupleId) {
      const doc = await read(coupleId);
      doc.trial_messages_used = (doc.trial_messages_used || 0) + 1;
      return write(coupleId, doc);
    },

    // Gate check: throws 402 if no more messages allowed. Also increments trial counter.
    async checkAndGate(coupleId) {
      const doc = await read(coupleId);
      const ts = new Date();

      // Active paid plan
      if (doc.plan && doc.status === "active" && doc.expires_at && new Date(doc.expires_at) > ts) {
        return doc;
      }

      const limit = doc.trial_messages_total * (doc.trial_extended ? 2 : 1);
      if ((doc.trial_messages_used || 0) < limit) {
        return this.incrementTrial(coupleId);
      }

      throw httpErr(402, "subscription_required");
    },
  };
}
