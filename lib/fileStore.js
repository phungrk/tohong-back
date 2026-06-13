// YAML nhẹ: dùng một thư viện nhỏ tương thích Workers, vd 'yaml'.
import YAML from "yaml";

export function makeStore(env) {
  const bucket = env.CHAT_DATA;

  async function getRaw(key) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return { text: await obj.text(), etag: obj.httpEtag };
  }

  return {
    async getJson(key) {
      const r = await getRaw(key);
      return r ? { value: JSON.parse(r.text), etag: r.etag } : null;
    },
    async putJson(key, value, opts = {}) {
      return put(key, JSON.stringify(value, null, 2), opts);
    },
    async getYaml(key) {
      const r = await getRaw(key);
      return r ? { value: YAML.parse(r.text), etag: r.etag } : null;
    },
    async putYaml(key, value, opts = {}) {
      return put(key, YAML.stringify(value), opts);
    },
    async getText(key) {
      const r = await getRaw(key);
      return r ? { value: r.text, etag: r.etag } : null;
    },
    async putText(key, value, opts = {}) {
      return put(key, value, opts);
    },
    async exists(key) {
      return (await bucket.head(key)) !== null;
    },
    async listPrefix(prefix, opts = {}) {
      const out = [];
      let cursor;
      do {
        const res = await bucket.list({
          prefix,
          cursor,
          limit: opts.limit || 1000,
        });
        out.push(...res.objects.map((o) => o.key));
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor && !opts.limit);
      return out;
    },
  };

  async function put(key, text, opts) {
    const conditions = {};
    if (opts.ifMatch) conditions.etagMatches = opts.ifMatch;
    if (opts.ifNoneMatch)
      conditions.etagDoesNotMatch =
        opts.ifNoneMatch === "*" ? undefined : opts.ifNoneMatch;
    const onlyIf =
      opts.ifNoneMatch === "*" ? { uploadedBefore: new Date(0) } : conditions;
    const res = await bucket.put(key, text, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf: Object.keys(onlyIf).length ? onlyIf : undefined,
    });
    if (!res) {
      const e = new Error("precondition failed");
      e.status = 412;
      throw e;
    }
    return res.httpEtag;
  }
}
