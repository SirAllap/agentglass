// What a Starboard session card says, decided apart from the screen.
//
// The words are the four the design allows: working, waiting on you, quiet N
// min, finished. A session that has said nothing for a while is "quiet" and the
// age is the whole claim. They read the Lantern's rows,
// the same ones the KPI strip counts, so a card and a number cannot disagree.
import type { LanternRow } from "../components/LanternView.tsx";
import { attention } from "../../../shared/fieldRules.ts";

export type CrewState = "working" | "ask" | "quiet" | "done";
export const CREW_ORDER: Record<CrewState, number> = { ask: 0, working: 1, quiet: 2, done: 3 };
export const CREW_WORD: Record<CrewState, string> = { ask: "waiting on you", working: "working", quiet: "quiet", done: "finished" };

/** Quiet starts after ten minutes of silence; before that a stopped session has just finished. */
export const QUIET_AFTER_MS = 10 * 60_000;

/** The state and when it began, from the row alone. Waiting means a permission
 *  or a held gate (the rail pip's rule); a turn that ended, or a session with no
 *  pane left, is finished. An idle session whose pane is alive (an open tool
 *  call, a subagent) is still working. */
export function crewState(r: LanternRow, now: number): { state: CrewState; since: number } {
  const last = r.facts?.lastSeen ?? r.saidAt ?? r.startedAt ?? now;
  if (attention(r, now) === "blocked") return { state: "ask", since: r.needsYou?.since ?? last };
  if (r.needsYou?.kind === "input") return { state: "done", since: r.needsYou.since };
  if (r.gone) return { state: "done", since: last };
  if (r.state === "working" || r.alive) return { state: "working", since: last };
  return { state: now - last >= QUIET_AFTER_MS ? "quiet" : "done", since: last };
}

/** The folder name of a project path: a card reads "orbit", not a home directory. */
export const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

/** "3 min", "2 h": the coarse age a card prints. */
export function ageWord(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Where each session sits on the Orrery: one ring per project (largest first,
 *  at most RINGS; the rest share the last), bodies spread evenly round a ring.
 *  The angle is layout only; the tip says so. */
export const RINGS = 4;
export interface Placed { row: LanternRow; ring: number; angle: number; project: string }
export function orreryLayout(rows: LanternRow[]): { placed: Placed[]; projects: string[]; projectCount: number } {
  const proj = (r: LanternRow) => r.project ?? r.worktree ?? "no project";
  const count = new Map<string, number>();
  for (const r of rows) count.set(proj(r), (count.get(proj(r)) ?? 0) + 1);
  const projects = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  const perRing: LanternRow[][] = Array.from({ length: Math.min(RINGS, projects.length) }, () => []);
  for (const r of rows) perRing[Math.min(projects.indexOf(proj(r)), RINGS - 1)]!.push(r);
  const placed: Placed[] = [];
  perRing.forEach((list, ring) => list.forEach((row, i) => {
    // A start offset per ring keeps neighbouring rings from lining up; the half step keeps
    // the first body off the top, where the ring's own label sits.
    placed.push({ row, ring, project: proj(row), angle: (i / list.length) * 360 + 180 / list.length + ring * 47 - 90 });
  }));
  return { placed, projects: projects.slice(0, RINGS), projectCount: projects.length };
}
