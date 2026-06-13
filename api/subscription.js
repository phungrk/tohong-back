import { makeSubscriptionStore } from "../lib/subscriptionStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";

/**
 * Routes:
 *   GET  /api/couples/:id/subscription         → get or create default
 *   POST /api/couples/:id/subscription          body: { plan } → activate plan
 *   POST /api/couples/:id/subscription/trial    → extend trial by 3 more messages
 */
export async function handleSubscription(request, env, auth, coupleId, tail) {
  validateId(coupleId);
  const method = request.method;
  const subStore = makeSubscriptionStore(env);

  // POST .../trial
  if (tail === "trial") {
    if (method !== "POST") return errorResponse(405, "method not allowed");
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    const doc = await subStore.extendTrial(coupleId);
    return jsonResponse({ subscription: doc });
  }

  if (method === "GET") {
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    const doc = await subStore.get(coupleId);
    return jsonResponse({ subscription: doc });
  }

  if (method === "POST") {
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
    const plan = typeof body?.plan === "string" ? body.plan : body?.plan?.id;
    if (!plan) return errorResponse(400, "plan required (m1|m3|m6|m12)");
    const doc = await subStore.activate(coupleId, plan);
    return jsonResponse({ subscription: doc }, 201);
  }

  return errorResponse(405, "method not allowed");
}
