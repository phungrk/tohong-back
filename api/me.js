import { makeStore } from "../lib/fileStore.js";
import { jsonResponse } from "../lib/http.js";

export async function handleMe(request, env, auth) {
  const store = makeStore(env);
  const rec = await store.getJson(`data/users/${auth.userId}.json`);
  const couples = rec?.value?.couples || [];
  return jsonResponse({
    user: { id: auth.userId, email: auth.email },
    couples,
  });
}
