import { makeStore } from "./fileStore.js";
import { newCoupleId, validateId } from "./ids.js";
import { httpErr } from "./auth.js";

const now = () => new Date().toISOString();

export function makeCoupleStore(env) {
  const store = makeStore(env);
  const membersKey = (c) => `data/couples/${c}/members.json`;
  const invitesKey = (c) => `data/couples/${c}/invites.json`;

  return {
    async createCouple(userId, email, input) {
      const coupleId = newCoupleId();
      const base = `data/couples/${coupleId}`;
      await store.putYaml(`${base}/profile.yaml`, {
        couple: {
          bride_name: input.bride_name || null,
          groom_name: input.groom_name || null,
          wedding_date: input.wedding_date || null,
        },
        families: {},
        preferences: {},
      });
      await store.putYaml(`${base}/memory.yaml`, { facts: [], decisions: [] });
      await store.putJson(membersKey(coupleId), [
        { user_id: userId, email, role: "owner", joined_at: now() },
      ]);
      await store.putJson(invitesKey(coupleId), []);
      await store.putJson(`${base}/conversations/index.json`, []);

      // cập nhật user record (cache)
      const key = `data/users/${userId}.json`;
      const existing = (await store.getJson(key))?.value || {
        user_id: userId,
        email,
        couples: [],
        created_at: now(),
      };
      existing.couples.push({ couple_id: coupleId, role: "owner" });
      existing.updated_at = now();
      await store.putJson(key, existing);

      return { couple_id: coupleId, role: "owner" };
    },

    async getProfile(coupleId) {
      validateId(coupleId);
      const p = await store.getYaml(`data/couples/${coupleId}/profile.yaml`);
      if (!p) throw httpErr(404, "couple not found");
      return p.value;
    },

    async updateProfile(coupleId, patch) {
      validateId(coupleId);
      const key = `data/couples/${coupleId}/profile.yaml`;
      const cur = (await store.getYaml(key))?.value || {};
      const merged = {
        ...cur,
        ...patch,
        couple: { ...cur.couple, ...patch.couple },
      };
      await store.putYaml(key, merged);
      return merged;
    },

    async listMembers(coupleId) {
      validateId(coupleId);
      const members = (await store.getJson(membersKey(coupleId)))?.value || [];
      const invites = (await store.getJson(invitesKey(coupleId)))?.value || [];
      return { members, invites: invites.filter((i) => i.status === "pending") };
    },

    async inviteMember(coupleId, email, role, invitedBy) {
      validateId(coupleId);
      if (!["member", "viewer", "owner"].includes(role))
        throw httpErr(400, "invalid role");
      const invites = (await store.getJson(invitesKey(coupleId)))?.value || [];
      invites.push({
        invite_id: `inv_${Date.now().toString(36)}`,
        email,
        role,
        invited_by: invitedBy,
        created_at: now(),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        status: "pending",
      });
      await store.putJson(invitesKey(coupleId), invites);
      return { ok: true };
    },

    async removeMember(coupleId, targetUserId) {
      validateId(coupleId);
      const members = (await store.getJson(membersKey(coupleId)))?.value || [];
      const owners = members.filter((m) => m.role === "owner");
      const target = members.find((m) => m.user_id === targetUserId);
      if (!target) throw httpErr(404, "member not found");
      if (target.role === "owner" && owners.length <= 1)
        throw httpErr(400, "cannot remove last owner");
      const next = members.filter((m) => m.user_id !== targetUserId);
      await store.putJson(membersKey(coupleId), next);

      // gỡ couple khỏi user record (cache)
      const ukey = `data/users/${targetUserId}.json`;
      const urec = (await store.getJson(ukey))?.value;
      if (urec) {
        urec.couples = (urec.couples || []).filter(
          (c) => c.couple_id !== coupleId,
        );
        urec.updated_at = now();
        await store.putJson(ukey, urec);
      }
      return { ok: true };
    },

    // Gọi khi user đăng nhập: chuyển invite khớp email thành member.
    // MVP: stub — cần index theo email mới làm gọn (xem ghi chú trong guide).
    async acceptInvitesForEmail(userId, email) {
      return { accepted: 0 };
    },
  };
}
