/*
 * Tell the orchestrator that the gate is holding something.
 *
 * Settings ▸ Agents ▸ Gate ▸ "Who answers". It is told, not asked: the chair is
 * an agent, and the party that can be held may not release a hold (see
 * mayReleaseAHold in index.ts), so the answer stays the person's whoever else
 * hears about it. What the chair gets is one line it can use to brief them or
 * to unstick the work around the hold.
 *
 * Its ceiling: one seat per project, found by the held call's checkout, and a
 * seat that is not sitting, or cannot be typed into, is skipped without a word
 * (promptSeat raises its own need for the second). Not a queue: a hold nobody
 * could tell the chair about is still in the person's list.
 */
import { everySeat } from "./seat.ts";
import { promptSeat } from "./seatwake.ts";
import { inScope } from "./config.ts";

/** The line the chair reads, bounded: a held command can be long. */
export function chairLine(tool: string, what: string, round = 0): string {
  const clip = what.replace(/\s+/g, " ").trim().slice(0, 240);
  return `${round ? `Still held (${round} of 2): ` : "Held at the gate: "}${tool}${clip ? ` · ${clip}` : ""}. Only the person can release it; brief them if it helps.`;
}

/** The root of the seat sitting over this checkout, or null. */
export function chairRoot(cwd: string | undefined, seats: { root: string; endedAt: number | null }[] = everySeat()): string | null {
  if (!cwd) return null;
  return seats.find((s) => s.endedAt === null && inScope(cwd, s.root))?.root ?? null;
}

export function tellChair(cwd: string | undefined, tool: string, what: string, round = 0, deps: { prompt?: typeof promptSeat; seats?: typeof everySeat } = {}): Promise<boolean> {
  const root = chairRoot(cwd, (deps.seats ?? everySeat)());
  if (!root) return Promise.resolve(false);
  return (deps.prompt ?? promptSeat)(root, chairLine(tool, what, round)).then(() => true, () => false);
}
