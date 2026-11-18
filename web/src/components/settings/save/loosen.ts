// What counts as LOOSENING what a worker may do, as pure functions. A loosening change asks once, on its row,
// before it saves; a tightening one stays instant with Undo. Undo itself never asks: it puts back what the person had.
import type { Envelope } from "../../../../../shared/orchestration.ts";

export const askText = (what: string): string => `Workers can ${what} from now on. Allow?`;

const items = (v: string | readonly string[]): string[] => (typeof v === "string" ? v.split("\n") : [...v]).map((x) => x.trim()).filter(Boolean);

/** A refusal list: dropping an item allows what it refused. Returns the items dropped. */
export const droppedRefusals = (was: string | readonly string[], now: string | readonly string[]): string[] => {
  const keep = new Set(items(now));
  return items(was).filter((x) => !keep.has(x));
};

/** A grant list: adding an item opens what it names. Returns the items added. */
export const addedGrants = (was: string | readonly string[], now: string | readonly string[]): string[] => {
  const had = new Set(items(was));
  return items(now).filter((x) => !had.has(x));
};

/** Plain words for each power an envelope holds, for "Workers can <x>". */
export const POWER_WORDS: Record<"write" | "commit" | "network" | "docker" | "worktreeOps", string> = {
  write: "write files in their own copy",
  commit: "commit in their own copy",
  network: "reach the internet",
  docker: "use Docker",
  worktreeOps: "merge, reset, check out or clean their copy",
};

/** The powers an envelope change turns on. Empty when it only narrows or leaves them alone. */
export const widenedPowers = (was: Envelope, now: Envelope): (keyof typeof POWER_WORDS)[] => {
  const out: (keyof typeof POWER_WORDS)[] = [];
  if (was.write === "none" && now.write === "worktree") out.push("write");
  for (const k of ["commit", "network", "docker", "worktreeOps"] as const) if (!was[k] && now[k]) out.push(k);
  return out;
};

/** A switch that turns a power on. */
export const switchedOn = (was: boolean, now: boolean): boolean => !was && now;

/** "a and b" / "a, b and c". */
export const sayList = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What changing the two envelopes would loosen, in words, or null when it only narrows. Undo is judged the same way: putting back a refusal loosens. */
export const envLoosens = (was: Record<"workerDefault" | "ceiling", Envelope>, next: Partial<Record<"workerDefault" | "ceiling", Envelope>>): string | null => {
  const words: string[] = [];
  for (const c of ["workerDefault", "ceiling"] as const) {
    const n = next[c]; if (!n) continue;
    for (const k of widenedPowers(was[c], n)) if (!words.includes(POWER_WORDS[k])) words.push(POWER_WORDS[k]);
    const dropped = droppedRefusals(was[c].deny, n.deny);
    if (dropped.length) words.push(`run ${sayList(dropped)}`);
  }
  return words.length ? sayList(words) : null;
};

/** `replaced` is set when this question took the place of an open one on another row, so the person is told the first was cancelled. */
export type Pending = { row: string; what: string; run: () => void; replaced?: boolean };

/** The pure core of the inline question: a tightening change runs at once, a loosening one waits for allow(). */
export function createLoosenGate(onChange: (p: Pending | null) => void) {
  let pending: Pending | null = null;
  const set = (p: Pending | null) => { pending = p; onChange(p); };
  return {
    gate(row: string, what: string | null, run: () => void) {
      if (what === null) { if (pending) set(null); run(); return; }
      set({ row, what, run, replaced: !!pending && pending.row !== row });
    },
    allow() { const p = pending; if (!p) return; set(null); p.run(); },
    cancel() { if (pending) set(null); },
    get pending() { return pending; },
  };
}
