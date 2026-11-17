// The Pull requests board's own list load, in one place: the board and the Jira card chips both call it, so one
// call path and one read in progress exist per checkout. No timer, no per-card read.
import { api } from "./api.ts";
import { listLoadOf, setListLoad } from "./prListChecks.ts";
import type { PrListResponse } from "../../../shared/types.ts";

type Fetch = (root: string, filter: "mine" | "review", state: "open" | "closed" | "all", force: boolean) => Promise<PrListResponse>;
type Pair = { mine: Promise<PrListResponse>; review: Promise<PrListResponse> };
const inflight = new Map<string, Pair>();

/** The board's two default lists ("mine", "review"); a second ask for the same read joins the one in flight. */
export function loadBoardLists(root: string, state: "open" | "closed" | "all", force = false, fetcher: Fetch = (r, f, s, fo) => api.prList(r, f, s, fo)): Pair {
  const key = `${root}\0${state}\0${force}`;
  const held = inflight.get(key);
  if (held) return held;
  const mine = fetcher(root, "mine", state, force);
  const review = fetcher(root, "review", state, force);
  const pair = { mine, review };
  inflight.set(key, pair);
  void Promise.allSettled([mine, review]).then(() => { inflight.delete(key); });
  return pair;
}

/** Jira side: when nothing has loaded this repo's list, run the board's load once; a load already in flight is joined. */
export function ensureListLoaded(repo: string, fetcher?: Fetch): void {
  if (listLoadOf(repo) !== "idle") return;
  setListLoad(repo, "loading");
  const waiting = inflight.size ? [...inflight.values()] : null;
  const pair = waiting ?? [loadBoardLists(`gh:${repo}`, "open", false, fetcher)];
  void Promise.allSettled(pair.flatMap((p) => [p.mine, p.review])).then((r) => {
    // The list answer itself marks its own repo done (publishListChecks); this closes the repo asked for.
    if (listLoadOf(repo) === "loading") setListLoad(repo, r.every((x) => x.status === "rejected") ? "failed" : "done");
  });
}
