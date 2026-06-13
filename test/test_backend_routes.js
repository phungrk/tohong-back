import { handleBudget } from "../api/budget.js";
import { handleTimeline } from "../api/timeline.js";
import { handleGuests } from "../api/guests.js";
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

  await test("budget GET returns an empty document instead of mock allocations", async () => {
    const response = await handleBudget(
      new Request("http://localhost/api/budget"),
      makeEnv(),
      AUTH,
      COUPLE_ID,
      null,
    );
    const body = await json(response);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.categories.length === 0, "expected no default budget categories");
    assert(body.total_tr === 0, "expected no invented budget target");
  });

  await test("timeline GET returns an empty structure instead of mock tasks", async () => {
    const response = await handleTimeline(
      new Request("http://localhost/api/timeline"),
      makeEnv(),
      AUTH,
      COUPLE_ID,
      null,
    );
    const body = await json(response);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.phases.length === 1, "expected one empty working phase");
    assert(body.phases[0].tasks.length === 0, "expected no default checklist tasks");
    assert(body.rundown.length === 0, "expected no default rundown");
  });

  await test("empty modules derive real onboarding values from the couple profile", async () => {
    const env = makeEnv();
    await env.CHAT_DATA.put(
      `data/couples/${COUPLE_ID}/profile.yaml`,
      JSON.stringify({
        couple: {
          budget_vnd: "500.000.000",
          guest_count: 180,
        },
      }),
    );
    const budgetResponse = await handleBudget(
      new Request("http://localhost/api/budget"),
      env,
      AUTH,
      COUPLE_ID,
      null,
    );
    const budget = await json(budgetResponse);
    assert(budget.total_tr === 500, `expected 500tr from profile, got ${budget.total_tr}`);
    assert(budget.guests === 180, `expected 180 guests from profile, got ${budget.guests}`);

    const guestsResponse = await handleGuests(
      new Request("http://localhost/api/guests"),
      env,
      AUTH,
      COUPLE_ID,
      null,
    );
    const guests = await json(guestsResponse);
    assert(guests.capacity === 180, `expected capacity 180 from profile, got ${guests.capacity}`);
    assert(guests.guests.length === 0, "expected no invented guests");
  });

  await test("budget proposal ignores legacy fake cache and fails without a real provider", async () => {
    const env = makeEnv();
    await env.CHAT_DATA.put(
      `data/couples/${COUPLE_ID}/budget.json`,
      JSON.stringify({
        total_tr: 100,
        guests: 50,
        mung_tr: 0,
        categories: [
          { id: "venue", name: "Địa điểm", amt: 60, items: [] },
          { id: "photo", name: "Chụp ảnh", amt: 40, items: [] },
        ],
      }),
    );
    await env.CHAT_DATA.put(
      `data/couples/${COUPLE_ID}/budget_proposal_cache.json`,
      JSON.stringify({
        title: "Legacy static fallback",
        changes: [],
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const response = await handleBudget(
      new Request("http://localhost/api/budget/proposal"),
      env,
      AUTH,
      COUPLE_ID,
      "proposal",
    );
    const body = await json(response);
    assert(response.status === 502, `expected 502, got ${response.status}`);
    assert(body.error === "ai_generation_failed", "expected explicit AI failure");
    assert(body.title === undefined, "must not serve legacy fake proposal");
  });

  await test("timeline suggestions ignore legacy fake cache and fail without a real provider", async () => {
    const env = makeEnv();
    await env.CHAT_DATA.put(
      `data/couples/${COUPLE_ID}/timeline.json`,
      JSON.stringify({
        phases: [],
        rundown: [
          { id: "r1", time: "09:00", name: "Lễ gia tiên", tag: "Lễ", done: false },
        ],
      }),
    );
    await env.CHAT_DATA.put(
      `data/couples/${COUPLE_ID}/timeline_suggestions_cache.json`,
      JSON.stringify({
        suggestions: [{ id: "s1", time: "10:00", label: "Static fallback" }],
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const response = await handleTimeline(
      new Request("http://localhost/api/timeline/suggestions"),
      env,
      AUTH,
      COUPLE_ID,
      "suggestions",
    );
    const body = await json(response);
    assert(response.status === 502, `expected 502, got ${response.status}`);
    assert(body.error === "ai_generation_failed", "expected explicit AI failure");
    assert(body.suggestions === undefined, "must not serve legacy fake suggestions");
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
