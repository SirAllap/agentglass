import { useCallback, useEffect, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";

export interface PersonRows { authored: PrSummary[]; asked: PrSummary[]; more: boolean }
export type PersonState = { kind: "idle" } | { kind: "loading" } | { kind: "failed"; error: string } | ({ kind: "ready" } & PersonRows);

/*
 * One person's board is asked for once and remembered for the session.
 *
 * Per repository and login, not per render: opening the same person again, or
 * coming back from the owner's board, reads this map and sends nothing. There is
 * no timer and no retry — a failed ask waits for the button. Pressing Enter in
 * the box is the only thing that can start a request, and typing never does.
 *
 * The ceiling: the answer is as old as the session. Reloading the app asks again.
 */
const done = new Map<string, PersonRows>();
const asking = new Map<string, Promise<PersonState>>();
const keyOf = (root: string, login: string) => `${root}\u0000${login.toLowerCase()}`;

export function askPerson(root: string, login: string, force = false): Promise<PersonState> {
  const key = keyOf(root, login);
  const hit = done.get(key);
  if (hit && !force) return Promise.resolve({ kind: "ready", ...hit });
  const flying = asking.get(key);
  if (flying) return flying;
  const p = api.prPerson(root, login, force).then((r): PersonState => {
    if (!r?.ok || !r.authored || !r.asked) return { kind: "failed", error: r?.error ?? "could not read" };
    const rows = { authored: r.authored, asked: r.asked, more: !!r.more };
    done.set(key, rows);
    return { kind: "ready", ...rows };
  }).catch((e): PersonState => ({ kind: "failed", error: String(e?.message ?? e) }))
    .finally(() => { asking.delete(key); });
  asking.set(key, p);
  return p;
}

/** Whether a person's board is already in hand — what "no request" is tested against. */
export function personKnown(root: string, login: string): boolean { return done.has(keyOf(root, login)); }
export function __forgetPeople(): void { done.clear(); asking.clear(); }

/** `login` null is the owner's own board: nothing is asked and nothing is held. */
export function usePersonBoard(root: string, login: string | null): { state: PersonState; retry: () => void } {
  const [state, setState] = useState<PersonState>({ kind: "idle" });
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!login || !root) { setState({ kind: "idle" }); return; }
    let live = true;
    const hit = done.get(keyOf(root, login));
    if (hit) setState({ kind: "ready", ...hit }); else setState({ kind: "loading" });
    if (!hit) void askPerson(root, login, again > 0).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [root, login, again]);
  const retry = useCallback(() => setAgain((n) => n + 1), []);
  return { state, retry };
}
