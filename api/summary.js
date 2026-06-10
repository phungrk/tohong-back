import { makeStore } from "../lib/fileStore.js";
import { makeGuestStore } from "../lib/guestStore.js";
import { requireCoupleAccess } from "../lib/auth.js";
import { validateId } from "../lib/ids.js";
import { jsonResponse, errorResponse } from "../lib/http.js";

export async function handleSummary(request, env, auth, coupleId) {
  validateId(coupleId);
  if (request.method !== "GET") return errorResponse(405, "method not allowed");
  await requireCoupleAccess(env, auth.userId, coupleId, "read");

  const store = makeStore(env);
  const base = `data/couples/${coupleId}`;

  // Parallel reads
  const [profileR, budgetR, timelineR, guestDoc] = await Promise.all([
    store.getYaml(`${base}/profile.yaml`),
    store.getJson(`${base}/budget.json`),
    store.getJson(`${base}/timeline.json`),
    makeGuestStore(env).get(coupleId),
  ]);

  const profile = profileR?.value?.couple || {};
  const budget = budgetR?.value;
  const timeline = timelineR?.value;

  // Budget summary
  let budgetSummary = { total_tr: 500, spent_tr: 0, over: false };
  if (budget) {
    const spent = (budget.categories || []).reduce((s, c) => s + (c.amt || 0), 0);
    budgetSummary = { total_tr: budget.total_tr || 500, spent_tr: spent, over: spent > (budget.total_tr || 500) };
  }

  // Timeline summary
  let timelineSummary = { done: 0, total: 0 };
  if (timeline?.phases) {
    const tasks = timeline.phases.flatMap((p) => p.tasks || []);
    timelineSummary = { done: tasks.filter((t) => t.done).length, total: tasks.length };
  }

  // Vendor summary — count budget items with vendor:true
  let vendorSummary = { confirmed: 0, shortlisted: 0, empty: 0 };
  if (budget?.categories) {
    const vendorItems = budget.categories.flatMap((c) => (c.items || []).filter((it) => it.vendor));
    vendorSummary.confirmed = vendorItems.filter((it) => it.vendor_status === "confirmed").length;
    vendorSummary.shortlisted = vendorItems.filter((it) => !it.vendor_status).length;
  }

  // Guest summary
  const guestSummary = guestDoc?.summary || { yes: 0, pending: 0, no: 0, total: 0 };
  const capacity = guestDoc?.capacity || 200;

  // Days left
  const weddingDate = profile.wedding_date;
  let daysLeft = null;
  let totalDays = null;
  let doneDays = null;
  if (weddingDate) {
    const wd = new Date(weddingDate);
    const now = new Date();
    daysLeft = Math.max(0, Math.ceil((wd - now) / 86400000));
    // totalDays = assume 365 day planning window for progress bar
    totalDays = 365;
    doneDays = Math.max(0, totalDays - daysLeft);
  }

  return jsonResponse({
    profile: {
      bride_name: profile.bride_name || null,
      groom_name: profile.groom_name || null,
      wedding_date: profile.wedding_date || null,
      city: profile.city || null,
    },
    days_left: daysLeft,
    total_days: totalDays,
    done_days: doneDays,
    budget: budgetSummary,
    timeline: timelineSummary,
    vendors: vendorSummary,
    guests: { ...guestSummary, capacity },
  });
}
