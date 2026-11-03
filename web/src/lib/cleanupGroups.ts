/*
 * CLEAN UP, GROUPED BY WHY.
 *
 * The Lantern listed forgotten servers one row each, a port, a program and a
 * folder. Fourteen servers left behind by one deleted checkout read as fourteen
 * problems; as one group with the ports as chips they are one decision and one
 * button. The reasons are the ones `forgottenPorts` already finds; this puts
 * each server in exactly ONE group, so the count on the big number is the count
 * of things a button will stop and no server is counted twice.
 *
 * Nothing here stops anything. A group carries the pids its button would stop,
 * and the screen sends them one by one to the existing kill route.
 */
import type { Forgotten } from "./portsForgotten.ts";

export interface SchedulePart { id: string; name: string; due: number; firedAt: number | null }

export type CleanKind = "left-behind" | "duplicates" | "idle" | "schedule";

/** `key` is the server's identity for Keep: program + folder + port, never the pid. */
export interface CleanChip { label: string; title: string; key: string }

export const keepKey = (p: Forgotten["port"]): string => `${p.proc ?? ""}\0${p.dir ?? p.cwd ?? ""}\0${p.port}`;

export interface CleanGroup {
  kind: CleanKind;
  /** What the big number says: servers that would be stopped, or 1 per schedule. */
  count: number;
  title: string;
  sub: string;
  chips: CleanChip[];
  /** Chips past the first five, drawn as "+9". */
  more: number;
  /** Oldest of them in whole days; null when none of them says how old it is. */
  oldestDays: number | null;
  /** The pids the group's button stops. */
  pids: number[];
  /** The schedule ids the button removes. */
  scheduleIds: string[];
  button: string;
}

export const CHIPS_SHOWN = 5;
/** A schedule whose time passed more than this ago and never fired will never fire. */
export const DEAD_SCHEDULE_AFTER_MS = 3_600_000;

/** The largest of the seconds the servers report, in whole days; null when none of them says. */
const oldestDays = (secs: (number | null)[]): number | null => {
  const known = secs.filter((n): n is number => n != null);
  return known.length ? Math.floor(Math.max(...known) / 86_400) : null;
};
const chip = (p: Forgotten["port"], n = 1): CleanChip => ({
  label: `:${p.port}${n > 1 ? ` x${n}` : ""}`,
  title: [p.proc, p.dir ?? p.cwd].filter(Boolean).join(" in "),
  key: keepKey(p),
});

function cap(chips: CleanChip[]): { chips: CleanChip[]; more: number } {
  return { chips: chips.slice(0, CHIPS_SHOWN), more: Math.max(0, chips.length - CHIPS_SHOWN) };
}

/** A schedule that can no longer fire: unfired, and past its time by more than the grace. */
export const isDeadSchedule = (s: SchedulePart, now = Date.now()): boolean =>
  !s.firedAt && now - s.due > DEAD_SCHEDULE_AFTER_MS;

export function groupCleanup(
  forgotten: readonly Forgotten[], schedules: readonly SchedulePart[], now = Date.now(), kept: ReadonlySet<string> = new Set(),
): { groups: CleanGroup[]; total: number } {
  const left: Forgotten[] = [];
  const dup: Forgotten[] = [];
  const idle: Forgotten[] = [];
  /* One group each, in the order a person would explain it: the folder is
     gone (nothing it does can matter), else it is a copy of another server,
     else it is only idle. */
  for (const f of forgotten) {
    if (kept.has(keepKey(f.port))) continue;
    if (f.port.cwdGone || f.port.tmpLeftover) left.push(f);
    else if (f.port.duplicate) dup.push(f);
    /* Idle is only a verdict on what an agent started: a server nobody
       connects to is the whole point of a memory server or a file gallery. */
    else if (f.port.fromAgent) idle.push(f);
  }
  const groups: CleanGroup[] = [];

  if (left.length) {
    const gone = left.every((f) => f.port.cwdGone);
    const c = cap(left.map((f) => chip(f.port)));
    groups.push({
      kind: "left-behind", count: left.length, title: "Left behind", sub: gone ? "folder deleted" : "folder deleted or temporary",
      ...c, oldestDays: oldestDays(left.map((f) => f.port.ageSec)),
      pids: left.flatMap((f) => (f.port.pid ? [f.port.pid] : [])), scheduleIds: [], button: `Stop all ${left.length}`,
    });
  }

  if (dup.length) {
    /* A set is the listeners of one program serving one folder. The newest of a
       set is the one a person is using; "Stop N older" stops the rest. */
    const sets = new Map<string, Forgotten[]>();
    for (const f of dup) {
      const key = `${f.port.proc ?? ""}\0${f.port.dir ?? f.port.cwd ?? ""}`;
      sets.set(key, [...(sets.get(key) ?? []), f]);
    }
    const older: Forgotten[] = [];
    const chips: CleanChip[] = [];
    for (const set of sets.values()) {
      const byAge = [...set].sort((a, b) => (a.port.ageSec ?? Infinity) - (b.port.ageSec ?? Infinity));
      const [keep, ...rest] = byAge;
      older.push(...rest);
      chips.push({ ...chip(keep!.port, set.length), title: `${set.map((s) => `:${s.port.port}`).join(" ")}, the newest stays` });
    }
    const c = cap(chips);
    if (older.length) {
      groups.push({
        kind: "duplicates", count: older.length, title: "Duplicates", sub: "same app, twice or more",
        ...c, oldestDays: oldestDays(older.map((f) => f.port.ageSec)),
        pids: older.flatMap((f) => (f.port.pid ? [f.port.pid] : [])), scheduleIds: [], button: `Stop ${older.length} older`,
      });
    }
  }

  if (idle.length) {
    const c = cap(idle.map((f) => chip(f.port)));
    groups.push({
      kind: "idle", count: idle.length, title: "Idle", sub: "nobody has connected for a while",
      ...c, oldestDays: oldestDays(idle.map((f) => f.port.idleSec)),
      pids: idle.flatMap((f) => (f.port.pid ? [f.port.pid] : [])), scheduleIds: [], button: `Stop all ${idle.length}`,
    });
  }

  for (const s of schedules.filter((x) => isDeadSchedule(x, now))) {
    groups.push({
      kind: "schedule", count: 1, title: "Dead schedule", sub: s.name, chips: [], more: 0,
      oldestDays: Math.max(0, Math.floor((now - s.due) / 86_400_000)), pids: [], scheduleIds: [s.id], button: "Remove",
    });
  }

  return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
}

/** The tile's stacked bar: one segment per kind with something in it, as a share of the total. */
export function stackShares(groups: readonly CleanGroup[]): { kind: CleanKind; count: number; pct: number }[] {
  const by = new Map<CleanKind, number>();
  for (const g of groups) by.set(g.kind, (by.get(g.kind) ?? 0) + g.count);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  return total ? [...by].map(([kind, count]) => ({ kind, count, pct: Math.max(2, Math.round((count / total) * 100)) })) : [];
}
