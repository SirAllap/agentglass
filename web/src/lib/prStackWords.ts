// What the stack marks SAY: the word on the base token and the sentences behind
// the spine, the token and the detail control.
//
// Kept out of the view because the words are the contract: a person who cannot
// see the colour has to be able to read the same thing, so every mark has a
// sentence, and a sentence that is built in a render cannot be tested.
//
// The word on the token is the most specific thing the app already knows about
// the base, in this order: the status its tracker card has (whatever the team
// calls it — nothing here names one), else the board column it sits in, else
// the pull request's own state. Nothing is fetched for it; absent means the
// next one down, never an error.

import type { LaneId } from "./prLanes.ts";
import type { BaseRef, Stack } from "./prStack.ts";

/** What the app knows about one pull request, whichever list it came from. */
export interface Facts {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  /** On the board right now (not filtered out, in a column). */
  onBoard: boolean;
  /** The column it sits in, when it has one — also for a filtered-out one. */
  lane?: LaneId;
  /** The tracker card's own status text, when the app already holds it. */
  status?: string;
}

const LANE_WORD: Record<LaneId, string> = {
  review: "needs review", land: "ready to land", blocked: "blocked", flight: "in flight", others: "waiting on others",
};

/** One rung of the ladder, already worded from what the app holds. */
export interface Rung { number: number; title: string; line: string }

export type Tone = "ok" | "info" | "warn" | "err" | "merged" | "muted";

/** The word, and the colour family it is drawn in. The word carries the meaning; the tone never has to. */
export function wordOf(f: Facts | undefined, base: BaseRef): { word: string; tone: Tone } {
  if (base.kind === "merged") return { word: "merged", tone: "merged" };
  if (base.kind === "closed") return { word: "closed", tone: "muted" };
  if (base.kind === "missing") return { word: "no PR", tone: "warn" };
  if (base.kind === "pending") return { word: "", tone: "muted" };
  if (f?.status) return { word: f.status.trim().toLowerCase(), tone: f.lane ? toneOfLane(f.lane) : "info" };
  if (f?.lane) return { word: LANE_WORD[f.lane], tone: toneOfLane(f.lane) };
  if (base.draft || f?.draft) return { word: "draft", tone: "muted" };
  return { word: "open", tone: "info" };
}

function toneOfLane(l: LaneId): Tone {
  return l === "land" ? "ok" : l === "blocked" ? "err" : l === "review" ? "warn" : l === "flight" ? "info" : "muted";
}

const where = (f: Facts | undefined, base: BaseRef) =>
  base.kind === "pr" ? (f?.onBoard ? "on this board" : "not on this board") : "";

/** The token's name and tooltip, one sentence. */
export function tokenSentence(base: BaseRef, f: Facts | undefined): string {
  if (base.kind === "missing") return `Base branch ${base.branch} has no pull request`;
  if (base.kind === "pending") return `Base branch ${base.branch}`;
  const w = wordOf(f, base).word;
  if (base.kind === "merged") return `Base pull request #${base.number} is merged but this one still targets its branch. Open it`;
  if (base.kind === "closed") return `Base pull request #${base.number} was closed without merging. Open it`;
  return `Base pull request #${base.number}, ${w}, ${where(f, base)}. Open it`;
}

/** The spine's name: one sentence a screen reader can say instead of the boxes. */
export function spineSentence(s: Stack, factsOf: (n: number) => Facts | undefined): string {
  const tier = `${s.position}${s.letter ?? ""} of ${s.size}`;
  const lead = s.letter ? `Stacked pull request ${tier}, on a fork.` : `Stacked pull request ${tier}.`;
  const parts: string[] = [];
  if (s.base?.kind === "pr") parts.push(`Base: #${s.base.number}, ${wordOf(factsOf(s.base.number), s.base).word}${factsOf(s.base.number)?.onBoard === false ? ", not on this board" : ""}.`);
  else if (s.base?.kind === "merged") parts.push(`Broken: the base #${s.base.number} is merged and this one still targets its branch.`);
  else if (s.base?.kind === "closed") parts.push(`Broken: the base #${s.base.number} was closed without merging.`);
  else if (s.base?.kind === "missing") parts.push(`Broken: the base branch ${s.base.branch} has no pull request.`);
  else if (!s.base) parts.push("It targets the trunk.");
  if (s.siblings.length) parts.push(`Sibling${s.siblings.length > 1 ? "s" : ""}: ${s.siblings.map((n) => `#${n}`).join(", ")}, on the same base.`);
  if (s.next.length) parts.push(`Next: ${s.next.map((n) => `#${n}, ${wordOf(factsOf(n), { kind: "pr", number: n, branch: "", draft: false }).word}`).join("; ")}.`);
  return [lead, ...parts].join(" ");
}
