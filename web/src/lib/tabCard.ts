/*
 * Which card a tab shows (bottom bar badge and side pane Card tab).
 *
 * The card the start named (`--card`, stored on the tab) is the answer. The
 * branch is only a guess for a tab nobody named a card for. When the guess is
 * an old tracker key (a branch cut before the card moved to Jira), the Jira
 * card that says "Migrated from ... <old key>" is shown instead.
 */
import { api } from "./api.ts";
import { cardRef, type CardRef } from "./cardRef.ts";
import { legacyKeysOf } from "./cardPrPick.ts";
import type { JiraReach } from "../../../shared/taskref.ts";

export function tabCardRef(
  named: string | null | undefined,
  branch: string,
  twinOf: (oldKey: string) => string | null,
  jira?: JiraReach,
): CardRef | null {
  if (named) {
    const n = cardRef({ headRefName: named }, jira);
    if (n) return n;
  }
  const guess = cardRef({ headRefName: branch }, jira);
  if (!guess || named) return guess;
  const twin = twinOf(guess.label);
  return twin ? cardRef({ headRefName: twin }, jira) ?? guess : guess;
}

type Ask = (oldKey: string) => Promise<string | null>;

/** Remembers, per old key, which Jira card replaced it: one lookup per key per session, a miss included. */
export function createTwinStore(ask: Ask) {
  const held = new Map<string, string | null>();
  const open = new Map<string, Promise<void>>();
  const subs = new Set<() => void>();
  let version = 0;
  return {
    twinOf(oldKey: string): string | null {
      const k = oldKey.trim().toUpperCase();
      if (held.has(k)) return held.get(k) ?? null;
      if (!open.has(k)) {
        open.set(k, ask(k).catch(() => null).then((t) => {
          held.set(k, t); version++;
          for (const f of subs) f();
        }));
      }
      return null;
    },
    settled: async () => { await Promise.all([...open.values()]); },
    version: () => version,
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}

/** The first candidate whose description names `oldKey` as the key it migrated from. A search hit alone proves nothing. */
export async function pickTwin(
  oldKey: string,
  candidates: readonly string[],
  descriptionOf: (key: string) => Promise<string | undefined>,
): Promise<string | null> {
  for (const key of candidates) {
    if (legacyKeysOf(await descriptionOf(key)).includes(oldKey.trim().toUpperCase())) return key;
  }
  return null;
}

async function findTwin(oldKey: string): Promise<string | null> {
  const r = await api.jiraJql(`description ~ "\\"Migrated from\\"" AND description ~ "\\"${oldKey}\\"" ORDER BY updated DESC`);
  const keys = (r.ok ? r.tasks ?? [] : []).slice(0, 5).map((t) => t.customId ?? t.id);
  return pickTwin(oldKey, keys, async (k) => (await api.jiraDetail(k)).detail?.description);
}

export const twins = createTwinStore(findTwin);
