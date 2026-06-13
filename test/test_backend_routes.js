import { handleBudget } from "../api/budget.js";
import { handleTimeline } from "../api/timeline.js";
import { handleSubscription } from "../api/subscription.js";
import { preflight } from "../lib/http.js";

const COUPLE_ID = "couple_20260604_q4m3st";
const AUTH = { userId: "user_dev" };

class MemoryBucket {
  constructor() {
    this.data = new Map();
  }

  async get(key) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return {
      httpEtag: `"${key}"`,
      text: async () => value,
    };
  }

  async put(key, value) {
    this.data.set(key, value);
    return { httpEtag: `"${key}"` };
  }

  async head(key) {
    return this.data.has(key) ? { key } : null;
  }
}

function makeEnv() {
  const bucket = new MemoryBucket();
  bucket.data.set(
    `data/couples/${COUPLE_ID}/members.json`,
    JSON.stringify([{ user_id: AUTH.userId, role: "owner" }]),
  );
  return { CHAT_DATA: bucket };
}

async function json(response) {
  return JSON.parse(await response.text());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

async function main() {
  console.log("\nBackend route regression tests\n");

  await test("budget GET returns the default document instead of 404", async () => {
    const response = await handleBudget(
      new Request("http://localhost/api/budget"),
      makeEnv(),
      AUTH,
      COUPLE_ID,
      null,
    );
    const body = await json(response);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.categories.length === 6, "expected default budget categories");
  });

  await test("timeline GET returns the default document instead of 404", async () => {
    const response = await handleTimeline(
      new Request("http://localhost/api/timeline"),
      makeEnv(),
      AUTH,
      COUPLE_ID,
      null,
    );
    const body = await json(response);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.phases.length === 5, "expected default timeline phases");
    assert(body.rundown.length === 7, "expected default rundown");
  });

  await test("subscription activation accepts the legacy plan object", async () => {
    const env = makeEnv();
    const response = await handleSubscription(
      new Request("http://localhost/api/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: { id: "m3", months: 3 } }),
      }),
      env,
      AUTH,
      COUPLE_ID,
      null,
    );
    const body = await json(response);
    assert(response.status === 201, `expected 201, got ${response.status}`);
    assert(body.subscription.plan === "m3", "expected normalized m3 plan");
    assert(body.subscription.status === "active", "expected active subscription");
  });

  await test("CORS preflight allows PUT persistence requests", async () => {
    const response = preflight();
    const methods = response.headers.get("Access-Control-Allow-Methods") || "";
    assert(response.status === 204, `expected 204, got ${response.status}`);
    assert(methods.split(",").map((v) => v.trim()).includes("PUT"), "expected PUT in allowed methods");
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
