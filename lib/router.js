export const DOMAIN_KEYWORDS = {
  budget: [
    "ngan sach",
    "tien",
    "chi phi",
    "gia",
    "bao nhieu",
    "tien mung",
    "coc",
    "dat coc",
  ],
  venue: [
    "nha hang",
    "hoi truong",
    "dia diem",
    "trung tam tiec",
    "ban tiec",
    "suc chua",
  ],
  vendor: [
    "chup anh",
    "photo",
    "mc",
    "ao cuoi",
    "makeup",
    "trang diem",
    "hoa",
    "ban nhac",
    "xe hoa",
    "in thiep",
  ],
  timeline: [
    "khi nao",
    "lich",
    "deadline",
    "con bao nhieu",
    "checklist",
    "chuan bi",
    "thang",
  ],
  guest: ["khach", "thiep", "rsvp", "xep ban", "so ban", "danh sach khach"],
  theme: ["mau", "theme", "phong cach", "decor", "trang tri", "style", "moodboard"],
  customs: [
    "dam ngo",
    "an hoi",
    "le cuoi",
    "trap",
    "ruoc dau",
    "xem ngay",
    "phong tuc",
    "tuoi",
    "mien bac",
    "mien nam",
    "mien trung",
  ],
};

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // bỏ dấu tiếng Việt
    .replace(/đ/g, "d");
}

// Trả [] (fallback → chỉ persona) hoặc tối đa 3 domain, ưu tiên nhiều hit nhất.
export function classifyDomains(message) {
  const text = normalize(message);
  const hits = [];
  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    const count = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (count > 0) hits.push({ domain, count });
  }
  return hits
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((h) => h.domain);
}
