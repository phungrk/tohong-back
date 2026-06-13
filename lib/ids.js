const ID_RE = /^[a-z0-9_]{1,64}$/;

export function validateId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    const e = new Error("invalid id");
    e.status = 400;
    throw e;
  }
  return id;
}

function rand(n) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function newCoupleId() {
  return `couple_${ymd()}_${rand(6)}`;
}

export function newConversationId(slug = "chat") {
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 20) || "chat";
  return `conv_${ymd()}_${clean}_${rand(3)}`;
}

export function newGuestId() {
  return `g_${rand(10)}`;
}

// ULID-lite: thời gian (sortable) + ngẫu nhiên. Đủ cho MVP.
export function newMessageId() {
  const t = Date.now().toString(36).padStart(9, "0");
  return { ulid: `${t}_${rand(6)}`, id: `msg_${t}${rand(4)}` };
}
