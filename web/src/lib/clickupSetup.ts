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
  /** How many boards are saved. Zero means there is nothing to open a card in. */
  boards: number;
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
      const value: ClickUpSetup = { boards: r.views.length, prefix: r.prefix || undefined };
      held = { at: Date.now(), value };
      return value;
    })
    .catch(() => ({ boards: 0 } as ClickUpSetup))
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
