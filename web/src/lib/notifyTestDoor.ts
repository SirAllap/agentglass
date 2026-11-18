import type { TestBy, TestKind } from "./notePolicy.ts";

/**
 * The mailbox between the `notify.test` agent door and the module that sends
 * notes (sysNotify.ts). The door only asks, after the delay the caller gave;
 * the sending, with all its routing, stays where the real notes are sent.
 *
 * The door is level 1, so any agent can call it. It may not flood: at most one
 * test of each kind waits to be sent at a time, and at most one of each kind
 * is asked for every TEST_GAP_MS. A refused ask throws, so the agent is told.
 */
const listeners = new Set<(kind: TestKind, by: TestBy) => void>();

export const TEST_GAP_MS = 10_000;
export type DoorState = { pending: Set<TestKind>; last: Map<TestKind, number> };
const door: DoorState = { pending: new Set(), last: new Map() };

/** Why this ask is refused, or null when it may go. Pure over its state. */
export function refuseTest(st: DoorState, kind: TestKind, now: number): string | null {
  if (st.pending.has(kind)) return `a ${kind} test is already waiting to be sent`;
  const last = st.last.get(kind);
  if (last !== undefined && now - last < TEST_GAP_MS) return `one ${kind} test per ${TEST_GAP_MS / 1000} s; try again in ${Math.ceil((TEST_GAP_MS - (now - last)) / 1000)} s`;
  return null;
}

export function askTestNote(kind: TestKind, seconds: number, st: DoorState = door, now = Date.now()): void {
  const no = refuseTest(st, kind, now);
  if (no) throw new Error(no);
  st.pending.add(kind);
  st.last.set(kind, now);
  setTimeout(() => {
    st.pending.delete(kind);
    for (const fn of listeners) fn(kind, "agent");
  }, Math.max(0, seconds) * 1000);
}

export function onTestNoteAsked(fn: (kind: TestKind, by: TestBy) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
