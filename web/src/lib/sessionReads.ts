/*
 * The repositories the person lets review plugins read the authoring session
 * of (`plugins.sessionReads.repos`). Held by the server, kept here so a row,
 * the Settings registry and an agent's read all see one answer.
 *
 * Empty until the person adds one: nothing is shared by default, and a failed
 * read or save leaves it empty or as it was, never wider.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface SessionReads { repos: string[]; known: string[] }

let held: SessionReads | null = null;
let inflight: Promise<SessionReads | null> | null = null;
const listeners = new Set<(v: SessionReads) => void>();

export function loadSessionReads(): Promise<SessionReads | null> {
  if (inflight) return inflight;
  inflight = api.sessionReads()
    .then((r) => {
      if (!r?.ok) return null;
      held = { repos: r.repos ?? [], known: r.known ?? [] };
      for (const l of listeners) l(held);
      return held;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Synchronous, because a SettingDef reads synchronously: nothing allowed until the server has said so. */
export function sessionReadReposNow(): string[] {
  if (!held) { void loadSessionReads(); return []; }
  return held.repos;
}

/** The repositories as the server will keep them: `owner/name`, lowercase, unique. */
export const cleanRepos = (list: readonly string[]): string[] =>
  [...new Set(list.map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(x)))];

/** The held list changes at once; a refusal puts the old one back. */
export function setSessionReadRepos(repos: readonly string[]): void {
  const before = held;
  const next = cleanRepos(repos);
  if (held) { held = { ...held, repos: next }; for (const l of listeners) l(held); }
  void api.setSessionReads(next)
    .then((r) => {
      if (!r?.ok) throw new Error("refused");
      if (held) { held = { ...held, repos: r.repos }; for (const l of listeners) l(held); }
    })
    .catch(() => { if (before) { held = before; for (const l of listeners) l(before); } });
}

/** For tests: forget what was read. */
export function __forgetSessionReads(): void { held = null; inflight = null; }

export function useSessionReads(): SessionReads | null {
  const [v, setV] = useState<SessionReads | null>(held);
  useEffect(() => {
    void loadSessionReads().then((r) => { if (r) setV(r); });
    listeners.add(setV);
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}
