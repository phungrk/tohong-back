import { httpErr } from "./auth.js";

export async function checkRateLimit(
  env,
  userId,
  bucket,
  limit = 30,
  windowSec = 300,
) {
  if (!env.RATE_LIMIT) return; // KV chưa cấu hình → bỏ qua (dev)
  const key = `rl:${bucket}:${userId}`;
  const cur = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (cur >= limit) throw httpErr(429, "rate limit exceeded");
  await env.RATE_LIMIT.put(key, String(cur + 1), { expirationTtl: windowSec });
}
