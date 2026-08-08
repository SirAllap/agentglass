/*
 * The queue, from what the app last fetched.
 *
 * `buildQueue` decides what counts as waiting on you, how the bands are ordered
 * and what each card says. It was the browser companion's and was imported
 * across the repository for as long as that existed; it now lives in
 * `src/model/` with its tests in `test/now-queue.test.ts` and
 * `test/queue-truth.test.ts`, which came over with it rather than being
 * rewritten — a second opinion about what "blocked" means would have been a
 * worse bug than any a rewrite could have fixed.
 *
 * What is here is the small part that is genuinely this hook's: memoising it,
 * and pinning `now` to the moment of the last load rather than to render time.
 * The second one matters — `buildQueue` uses `now` to decide whether a silent
 * session is thinking or stopped, so passing `Date.now()` on every render makes
 * a card appear because the list re-rendered rather than because anything
 * moved.
 *
 * `trees` is not passed, so a checkout stopped half-way through a rebase draws
 * no card here. `buildQueue` supports it and `haltState.ts` writes the copy —
 * the store simply never fetches git state. Left as it was found: wiring it is
 * a change to what the phone shows, not to where this code lives.
 */
import { useMemo } from "react";
import { buildQueue, type NowItem } from "../model/nowQueue.ts";
import type { Fleet } from "./host-context.tsx";

export function useQueue(fleet: Fleet): NowItem[] {
  return useMemo(
    () => buildQueue({
      gates: fleet.gates,
      sessions: fleet.sessions,
      // Filled by the store's slower pass — see `loadPrs`. Empty means "not
      // asked yet" rather than "there are none", and the difference shows as
      // cards appearing a moment later rather than as a claim that a repository
      // is fine.
      prs: fleet.prs,
      containers: fleet.containers,
      me: fleet.me,
      now: fleet.at || Date.now(),
    }),
    [fleet],
  );
}
