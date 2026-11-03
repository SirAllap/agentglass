// The tags-on-remote answer costs the network (8 s for a silent remote), so it is
// kept: 60 s when every remote answered, 30 s when one stayed silent, and a
// request that arrives while the same question is in flight shares its answer.
const FULL_TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 30_000;

export interface TagsOriginCache {
  get(key: string, refs: number, load: () => Promise<string>): Promise<string>;
  clear(): void;
}

export function makeTagsOriginCache(now: () => number = Date.now): TagsOriginCache {
  const done = new Map<string, { refs: number; at: number; ttl: number; body: string }>();
  const flying = new Map<string, Promise<string>>();
  return {
    async get(key, refs, load) {
      const hit = done.get(key);
      if (hit && hit.refs === refs && now() - hit.at < hit.ttl) return hit.body;
      const slot = `${key}\0${refs}`;
      const live = flying.get(slot);
      if (live) return live;
      const p = load().then((body) => {
        if (done.size > 40) done.clear();
        done.set(key, { refs, at: now(), ttl: body.includes('"unknown"') ? UNKNOWN_TTL_MS : FULL_TTL_MS, body });
        return body;
      }).finally(() => { flying.delete(slot); });
      flying.set(slot, p);
      return p;
    },
    clear() { done.clear(); },
  };
}
