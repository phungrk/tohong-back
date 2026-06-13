import { makeStore } from "./fileStore.js";
import { newConversationId, newMessageId, validateId } from "./ids.js";
import { httpErr } from "./auth.js";

const now = () => new Date().toISOString();

export function makeConversationStore(env) {
  const store = makeStore(env);
  const idxKey = (c) => `data/couples/${c}/conversations/index.json`;
  const metaKey = (c, id) => `data/couples/${c}/conversations/${id}/meta.yaml`;
  const msgPrefix = (c, id) =>
    `data/couples/${c}/conversations/${id}/messages/`;

  const api = {
    async list(coupleId, limit = 10, status = "active") {
      validateId(coupleId);
      const idx = (await store.getJson(idxKey(coupleId)))?.value || [];
      return idx
        .filter((c) => c.status === status)
        .sort((a, b) =>
          (b.last_message_at || "").localeCompare(a.last_message_at || ""),
        )
        .slice(0, limit);
    },

    async create(coupleId, title) {
      validateId(coupleId);
      const id = newConversationId(title);
      const ts = now();
      const safeTitle = title || "Cuộc trò chuyện mới";
      await store.putYaml(metaKey(coupleId, id), {
        id,
        couple_id: coupleId,
        title: safeTitle,
        status: "active",
        created_at: ts,
        updated_at: ts,
        last_message_at: ts,
        message_count: 0,
        last_summarized_message_count: 0,
      });
      const idx = (await store.getJson(idxKey(coupleId)))?.value || [];
      idx.push({
        id,
        title: safeTitle,
        last_message_at: ts,
        created_at: ts,
        message_count: 0,
        status: "active",
      });
      await store.putJson(idxKey(coupleId), idx);
      return { id, title: safeTitle };
    },

    async getMeta(coupleId, conversationId) {
      validateId(coupleId);
      validateId(conversationId);
      const m = await store.getYaml(metaKey(coupleId, conversationId));
      if (!m) throw httpErr(404, "conversation not found");
      return m.value;
    },

    async update(coupleId, conversationId, patch) {
      const meta = await api.getMeta(coupleId, conversationId);
      const merged = { ...meta, ...patch, updated_at: now() };
      await store.putYaml(metaKey(coupleId, conversationId), merged);
      // sync index
      const idx = (await store.getJson(idxKey(coupleId)))?.value || [];
      const i = idx.findIndex((c) => c.id === conversationId);
      if (i >= 0) {
        if (merged.status === "deleted") idx.splice(i, 1);
        else
          idx[i] = {
            ...idx[i],
            title: merged.title,
            status: merged.status,
            last_message_at: merged.last_message_at,
            message_count: merged.message_count,
          };
        await store.putJson(idxKey(coupleId), idx);
      }
      return merged;
    },

    async getMessages(coupleId, conversationId, { cursor, limit = 50 } = {}) {
      validateId(coupleId);
      validateId(conversationId);
      const prefix = msgPrefix(coupleId, conversationId);
      let keys = (await store.listPrefix(prefix)).sort();
      if (cursor) keys = keys.filter((k) => k > `${prefix}${cursor}`);
      const page = keys.slice(0, limit);
      const messages = [];
      for (const k of page) {
        const r = await store.getJson(k);
        if (r) messages.push(r.value);
      }
      const nextCursor =
        keys.length > limit ? page[page.length - 1].split("/").pop() : null;
      return { messages, next_cursor: nextCursor };
    },

    async appendMessage(coupleId, conversationId, { role, content, metadata }) {
      const { ulid, id } = newMessageId();
      const meta = await api.getMeta(coupleId, conversationId);
      const seq = (meta.message_count || 0) + 1;
      const ts = now();
      const msg = {
        id,
        seq,
        role,
        content,
        created_at: ts,
        metadata: metadata || {},
      };
      const key = `${msgPrefix(coupleId, conversationId)}${ulid}_${id}.json`;
      await store.putJson(key, msg, { ifNoneMatch: "*" }); // immutable
      await api.update(coupleId, conversationId, {
        message_count: seq,
        last_message_at: ts,
      });
      return msg;
    },

    async rebuildIndex(coupleId) {
      validateId(coupleId);
      const prefix = `data/couples/${coupleId}/conversations/`;
      const keys = await store.listPrefix(prefix);
      const metas = keys.filter((k) => k.endsWith("/meta.yaml"));
      const idx = [];
      for (const k of metas) {
        const meta = (await store.getYaml(k))?.value;
        if (meta && meta.status !== "deleted") {
          idx.push({
            id: meta.id,
            title: meta.title,
            last_message_at: meta.last_message_at,
            created_at: meta.created_at,
            message_count: meta.message_count,
            status: meta.status,
          });
        }
      }
      await store.putJson(idxKey(coupleId), idx);
      return idx;
    },
  };

  return api;
}
