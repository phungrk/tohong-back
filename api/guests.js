import { makeGuestStore } from "../lib/guestStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";
import { makeStore } from "../lib/fileStore.js";

export async function handleGuests(request, env, auth, coupleId, guestId) {
  validateId(coupleId);
  const method = request.method;
  const gs = makeGuestStore(env);

  // /api/couples/:id/guests/:gid  — single guest operations
  if (guestId) {
    if (method === "PATCH") {
      await requireCoupleAccess(env, auth.userId, coupleId, "write");
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
      const guest = await gs.update(coupleId, guestId, body);
      return jsonResponse({ guest });
    }
    if (method === "DELETE") {
      await requireCoupleAccess(env, auth.userId, coupleId, "write");
      return jsonResponse(await gs.remove(coupleId, guestId));
    }
    return errorResponse(405, "method not allowed");
  }

  // /api/couples/:id/guests  — collection operations
  if (method === "GET") {
    await requireCoupleAccess(env, auth.userId, coupleId, "read");
    const doc = await gs.get(coupleId);
    // Return empty doc if not yet initialized (200, not 404)
    if (!doc) {
      const profileDoc = (
        await makeStore(env)
          .getYaml(`data/couples/${coupleId}/profile.yaml`)
          .catch(() => null)
      )?.value ?? {};
      const profile = profileDoc.couple ?? profileDoc;
      const capacity = Math.max(0, parseInt(profile.guest_count, 10) || 0);
      return jsonResponse({
        capacity,
        guests: [],
        summary: { yes: 0, pending: 0, no: 0, total: 0 },
      });
    }
    return jsonResponse(doc);
  }

  if (method === "POST") {
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid JSON"); }
    const guest = await gs.add(coupleId, body);
    return jsonResponse({ guest }, 201);
  }

  return errorResponse(405, "method not allowed");
}
