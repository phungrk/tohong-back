import { requireCoupleAccess } from "../lib/auth.js";
import { makeCoupleStore } from "../lib/coupleStore.js";
import { makeConversationStore } from "../lib/conversationStore.js";
import { handleCoupleChat } from "./coupleChat.js";
import { handleBudget } from "./budget.js";
import { handleTimeline } from "./timeline.js";
import { handleGuests } from "./guests.js";
import { handleSummary } from "./summary.js";
import { handleSubscription } from "./subscription.js";
import { handleBriefing } from "./briefing.js";
import { jsonResponse, errorResponse } from "../lib/http.js";

/**
 * Route mọi thứ dưới /api/couples.
 * segs = các đoạn path SAU "couples", vd:
 *   []                                  POST → tạo couple
 *   [id]                                GET/PATCH → profile
 *   [id, "members"]                     GET/POST
 *   [id, "members", userId]             DELETE
 *   [id, "conversations"]               GET/POST
 *   [id, "conversations", cid]          PATCH/DELETE
 *   [id, "conversations", cid, "messages"]  GET
 *   [id, "chat"]                        POST
 */
export async function routeCouples(request, env, auth, ctx, segs) {
  const method = request.method;
  const coupleId = segs[0];

  // POST /api/couples → tạo workspace mới
  if (!coupleId) {
    if (method !== "POST") return errorResponse(405, "method not allowed");
    const body = await request.json();
    const couple = await makeCoupleStore(env).createCouple(
      auth.userId,
      auth.email,
      body,
    );
    return jsonResponse({ couple }, 201);
  }

  const sub = segs[1];
  const coupleStore = makeCoupleStore(env);
  const convStore = makeConversationStore(env);

  // /api/couples/:id  (profile)
  if (!sub) {
    if (method === "GET") {
      await requireCoupleAccess(env, auth.userId, coupleId, "read");
      return jsonResponse({ profile: await coupleStore.getProfile(coupleId) });
    }
    if (method === "PATCH") {
      await requireCoupleAccess(env, auth.userId, coupleId, "admin");
      const patch = await request.json();
      return jsonResponse({
        profile: await coupleStore.updateProfile(coupleId, patch),
      });
    }
    return errorResponse(405, "method not allowed");
  }

  // /api/couples/:id/members
  if (sub === "members") {
    const targetUserId = segs[2];
    if (!targetUserId && method === "GET") {
      await requireCoupleAccess(env, auth.userId, coupleId, "read");
      return jsonResponse(await coupleStore.listMembers(coupleId));
    }
    if (!targetUserId && method === "POST") {
      await requireCoupleAccess(env, auth.userId, coupleId, "admin");
      const { email, role } = await request.json();
      if (!email) return errorResponse(400, "email required");
      return jsonResponse(
        await coupleStore.inviteMember(
          coupleId,
          email,
          role || "member",
          auth.userId,
        ),
      );
    }
    if (targetUserId && method === "DELETE") {
      await requireCoupleAccess(env, auth.userId, coupleId, "admin");
      return jsonResponse(
        await coupleStore.removeMember(coupleId, targetUserId),
      );
    }
    return errorResponse(405, "method not allowed");
  }

  // /api/couples/:id/conversations
  if (sub === "conversations") {
    const cid = segs[2];
    const tail = segs[3];

    if (!cid) {
      if (method === "GET") {
        await requireCoupleAccess(env, auth.userId, coupleId, "read");
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const status = url.searchParams.get("status") || "active";
        return jsonResponse({
          conversations: await convStore.list(coupleId, limit, status),
        });
      }
      if (method === "POST") {
        await requireCoupleAccess(env, auth.userId, coupleId, "write");
        const { title } = await request.json().catch(() => ({}));
        return jsonResponse(
          { conversation: await convStore.create(coupleId, title) },
          201,
        );
      }
      return errorResponse(405, "method not allowed");
    }

    // /api/couples/:id/conversations/:cid/messages
    if (tail === "messages" && method === "GET") {
      await requireCoupleAccess(env, auth.userId, coupleId, "read");
      const url = new URL(request.url);
      const cursor = url.searchParams.get("after") || undefined;
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const meta = await convStore.getMeta(coupleId, cid);
      const { messages, next_cursor } = await convStore.getMessages(
        coupleId,
        cid,
        { cursor, limit },
      );
      return jsonResponse({
        conversation: { id: meta.id, title: meta.title },
        messages,
        next_cursor,
      });
    }

    // /api/couples/:id/conversations/:cid  (PATCH / DELETE)
    if (!tail && method === "PATCH") {
      await requireCoupleAccess(env, auth.userId, coupleId, "write");
      const patch = await request.json();
      const allowed = {};
      if (patch.title !== undefined) allowed.title = patch.title;
      if (patch.status !== undefined) allowed.status = patch.status;
      return jsonResponse({
        conversation: await convStore.update(coupleId, cid, allowed),
      });
    }
    if (!tail && method === "DELETE") {
      await requireCoupleAccess(env, auth.userId, coupleId, "write");
      await convStore.update(coupleId, cid, { status: "deleted" });
      return jsonResponse({ ok: true });
    }
    return errorResponse(405, "method not allowed");
  }

  // /api/couples/:id/chat
  if (sub === "chat") {
    if (method !== "POST") return errorResponse(405, "method not allowed");
    await requireCoupleAccess(env, auth.userId, coupleId, "write");
    return await handleCoupleChat(request, env, auth, coupleId, ctx);
  }

  // /api/couples/:id/budget  and  /api/couples/:id/budget/proposal
  if (sub === "budget") {
    const tail = segs[2] || null;
    return await handleBudget(request, env, auth, coupleId, tail);
  }

  // /api/couples/:id/timeline  and  /api/couples/:id/timeline/suggestions
  if (sub === "timeline") {
    const tail = segs[2] || null;
    return await handleTimeline(request, env, auth, coupleId, tail);
  }

  // /api/couples/:id/summary
  if (sub === "summary") return await handleSummary(request, env, auth, coupleId);

  // /api/couples/:id/guests  and  /api/couples/:id/guests/:gid
  if (sub === "guests") {
    const guestId = segs[2] || null;
    return await handleGuests(request, env, auth, coupleId, guestId);
  }

  // /api/couples/:id/subscription  and  /api/couples/:id/subscription/trial
  if (sub === "subscription") {
    const tail = segs[2] || null;
    return await handleSubscription(request, env, auth, coupleId, tail);
  }

  // /api/couples/:id/briefing
  if (sub === "briefing") return await handleBriefing(request, env, auth, coupleId);

  return errorResponse(404, "not found");
}
