/*
 * Is there a ClickUp here, and what do its card ids look like?
 *
 * Asked by surfaces that are not the ClickUp board — the pull-request masthead,
 * which has a branch name and needs to know whether `ORBIT-1042` in it means
 * anything on this machine before it offers to open a card.
 *
 * The answer is read from the local store (no call leaves the machine), and
 * held for a minute so opening twenty pull requests is one read rather than
 * twenty. A minute rather than forever because connecting ClickUp and adding a
 * board are things somebody does WHILE the app is open, and a chip that only
 * appears after a restart reads as broken.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface ClickUpSetup {
  /**
   * Is there a ClickUp on this machine — a token, not a tab.
   *
   * This used to be `boards: number`, read off the length of the saved-view
   * list, and it was wrong in the one direction that matters: the built-in
   * "Assigned to me" board is always in that list, so the count was never zero
   * and every caller asking "is ClickUp set up here" got yes. A repository
   * whose branches are `ABC-1234-thing` — a Jira shop, a Linear shop, anybody —
   * got a ClickUp mark on its pull requests and a chip that led to the connect
   * screen.
   *
   * A count could not have been fixed by comparing it against a different
   * number, because there is no number here that means what this means. So the
   * server states it and this carries it, and there is nothing left to
   * misread.
   */
  connected: boolean;
  /** `ORBIT-`, when a board has been read. Undefined is "unknown", never "none". */
  prefix?: string;
}

const TTL = 60_000;
let held: { at: number; value: ClickUpSetup } | null = null;
let inflight: Promise<ClickUpSetup> | null = null;

const fresh = (): ClickUpSetup | null => (held && Date.now() - held.at < TTL ? held.value : null);

export function clickupSetup(): Promise<ClickUpSetup> {
  const now = fresh();
  if (now) return Promise.resolve(now);
  // One read for however many callers arrive while it is in the air. A failure
  // is NOT cached: the server being down for a moment should not hide a card
  // link for the next minute.
  inflight ??= api.clickupViews()
    .then((r) => {
      const value: ClickUpSetup = { connected: r.connected === true, prefix: r.prefix || undefined };
      held = { at: Date.now(), value };
      return value;
    })
    // A server that did not answer is not a machine with ClickUp on it. The
    // failure is not cached (see above), so this is "not while I cannot ask"
    // rather than "no" — and the quiet answer is the safe one either way.
    .catch(() => ({ connected: false } as ClickUpSetup))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Null until the answer is in — which is what keeps a chip from flashing on
 *  and then off again on a machine with no ClickUp. */
export function useClickupSetup(): ClickUpSetup | null {
  const [setup, setSetup] = useState<ClickUpSetup | null>(fresh);
  useEffect(() => {
    let live = true;
    void clickupSetup().then((v) => { if (live) setSetup(v); });
    return () => { live = false; };
  }, []);
  return setup;
}

/** For a test's own teardown, and for the moment a board is added. */
export function __forgetClickupSetup(): void { held = null; }
