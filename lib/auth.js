let jwksCache = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getJwks(env) {
  if (jwksCache && Date.now() - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(env.CLERK_JWKS_URL);
  jwksCache = await res.json();
  jwksCachedAt = Date.now();
  return jwksCache;
}

function b64urlToBuf(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw httpErr(401, "missing token");

  // ── DEV BYPASS ──────────────────────────────────────────────────────────
  // Chỉ hoạt động khi env.DEV_AUTH_BYPASS được set (chỉ có trong .dev.vars,
  // KHÔNG BAO GIỜ deploy → production an toàn). Token dạng:
  //   "dev"                          → user_dev / dev@example.com
  //   "dev:user_abc"                 → user_abc
  //   "dev:user_abc:mail@x.com"      → user_abc / mail@x.com
  if (env.DEV_AUTH_BYPASS && (token === "dev" || token.startsWith("dev:"))) {
    const [, uid, email] = token.split(":");
    return {
      userId: uid || "user_dev",
      email: email || "dev@example.com",
    };
  }

  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw httpErr(401, "malformed token");

  const head = JSON.parse(new TextDecoder().decode(b64urlToBuf(h)));
  const jwks = await getJwks(env);
  const jwk = jwks.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw httpErr(401, "unknown key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBuf(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw httpErr(401, "bad signature");

  const claims = JSON.parse(new TextDecoder().decode(b64urlToBuf(p)));
  if (claims.iss !== env.CLERK_ISSUER) throw httpErr(401, "bad issuer");
  if (claims.exp && claims.exp * 1000 < Date.now())
    throw httpErr(401, "expired");

  return {
    userId: claims.sub,
    email: claims.email || claims.email_address || null,
  };
}

export function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── Phase 2: authorization từ members.json ──────────────────────────────
import { makeStore } from "./fileStore.js";
import { validateId } from "./ids.js";

const PERM_RANK = { viewer: 1, member: 2, owner: 3 };
const REQUIRED = { read: 1, write: 2, admin: 3 };

export async function requireCoupleAccess(env, userId, coupleId, permission) {
  validateId(coupleId);
  const store = makeStore(env);
  const members = (
    await store.getJson(`data/couples/${coupleId}/members.json`)
  )?.value;
  if (!members) throw httpErr(404, "couple not found");
  const me = members.find((m) => m.user_id === userId);
  if (!me) throw httpErr(403, "no access to couple");
  if (PERM_RANK[me.role] < REQUIRED[permission])
    throw httpErr(403, "insufficient role");
  return me;
}
