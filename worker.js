/**
 * Cloudflare Workers entry point.
 *
 * Routes:
 *   POST /api/chat            — legacy stateless (giữ tạm trong lúc migrate)
 *   GET  /api/providers       — health check
 *   GET  /api/me              — user + couple memberships (cần auth)
 *   *    /api/couples/...      — couple workspace, conversations, chat (cần auth)
 *
 * Deploy:
 *   npm run deploy:cf   (= build:prompts && wrangler deploy)
 */

import { handleChatRequest, handleProvidersRequest } from "./lib/handler.js";
import { verifyAuth } from "./lib/auth.js";
import { errorResponse, preflight } from "./lib/http.js";
import { handleMe } from "./api/me.js";
import { routeCouples } from "./api/couples.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return preflight();

    try {
      // Legacy stateless (không auth) — gỡ khi frontend đã chuyển hẳn sang couple chat
      if (path === "/api/chat") return await handleChatRequest(request, env);
      if (path === "/api/providers") return await handleProvidersRequest(request, env);

      // Các route cần auth
      if (path === "/api/me") {
        const auth = await verifyAuth(request, env);
        return await handleMe(request, env, auth);
      }

      if (path === "/api/couples" || path.startsWith("/api/couples/")) {
        const auth = await verifyAuth(request, env);
        const segs = path
          .replace(/^\/api\/couples\/?/, "")
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
        return await routeCouples(request, env, auth, ctx, segs);
      }

      return errorResponse(404, "Not found");
    } catch (err) {
      return errorResponse(err.status || 500, err.message || "Internal error");
    }
  },

  // Không cần queue consumer ở MVP — summarization chạy đồng bộ qua ctx.waitUntil.
};
