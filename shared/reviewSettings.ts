/*
 * Who reviews and checks, per project: the orchestrator's own reading, the
 * Builder-to-Reviewer loop's cap, and an optional second reviewer on another
 * engine. One module so the settings door, the Orchestration page and the
 * seat's standing instructions all read the same values and the same ceilings.
 *
 * The default is `second`, which is how the app already worked: the separate
 * Reviewer reads first and the chair reads the same diff again. `never` turns
 * that reading off, and is chosen.
 */
import { agentProvider } from "./agentKinds.ts";
import type { EngineReadiness } from "./types.ts";

export const REVIEW_SETTING_IDS = {
  who: "orchestration.review.who",
  rounds: "orchestration.review.rounds",
  second: "orchestration.review.second",
} as const;

export const REVIEW_WHO = ["never", "second", "is"] as const;
export type ReviewWho = (typeof REVIEW_WHO)[number];
/** Today's answer: the separate Reviewer reads first and the chair reads the
 *  same diff again. */
export const DEFAULT_REVIEW_WHO: ReviewWho = "second";
export const isReviewWho = (v: unknown): v is ReviewWho =>
  typeof v === "string" && (REVIEW_WHO as readonly string[]).includes(v);

export const REVIEW_ROUNDS_MIN = 1;
export const REVIEW_ROUNDS_MAX = 6;
export const DEFAULT_REVIEW_ROUNDS = 3;

export interface SecondReviewer {
  engine: string;
  model: string;
}

const SECOND_SHAPE = 'an object {"engine": "...", "model": "..."}, or null for off';

/** A second reviewer as it is stored: null is off. Engine ids come from the provider table. */
export function checkSecondReviewer(
  raw: unknown,
  readiness?: readonly EngineReadiness[],
): { value: SecondReviewer | null } | { error: string } {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  /* A json setting arrives as text from the CLI, so "null" and the documented
     JSON both have to land here; SKILL.md shows the command an agent types. */
  if (typeof raw === "string") {
    if (raw.trim() === "null") return { value: null };
    try { return checkSecondReviewer(JSON.parse(raw), readiness); } catch { return { error: SECOND_SHAPE }; }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: SECOND_SHAPE };
  const o = raw as { engine?: unknown; model?: unknown };
  if (typeof o.engine !== "string" || !agentProvider(o.engine)) return { error: "engine: an engine id this app knows" };
  if (o.model !== undefined && (typeof o.model !== "string" || o.model.length > 120 || /[\s\0]/.test(o.model)))
    return { error: "model: one word, or empty for the engine's default" };
  /* Readiness is left out on the page's first check; the server passes it and refuses
     an engine that cannot take the worker role here. */
  const ready = readiness?.find((e) => e.id === o.engine)?.roles.worker.ok;
  if (readiness && !ready)
    return { error: `${agentProvider(o.engine)!.title} cannot take a worker role on this machine, so it cannot be the second reviewer. Pick an engine that can.` };
  return { value: { engine: o.engine, model: (o.model ?? "").trim() } };
}

/** A stored value (JSON text, as the settings store keeps it) as a second reviewer, or null. */
export function secondFromStored(raw: unknown): SecondReviewer | null {
  let v = raw;
  if (typeof v === "string") {
    if (!v) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  const checked = checkSecondReviewer(v);
  return "value" in checked ? checked.value : null;
}

/* Ranked by what the CHAIR reads and runs, which is what "safer" means here:
   is -> second removes the chair's own read but adds a Reviewer agent and its
   rounds, so it is ranked as a narrowing and applies at once. */
const WHO_RANK: Record<ReviewWho, number> = { never: 0, second: 1, is: 2 };
/** A lower answer reads and runs less: the safer direction an agent may take alone. */
export const whoNarrows = (prev: unknown, next: unknown): boolean =>
  isReviewWho(prev) && isReviewWho(next) && WHO_RANK[next] < WHO_RANK[prev];
/** Fewer rounds spend less. */
export const roundsNarrows = (prev: unknown, next: unknown): boolean =>
  typeof prev === "number" && typeof next === "number" && next < prev;
/** Turning the second reviewer off is the cheaper direction. */
export const secondNarrows = (prev: unknown, next: unknown): boolean => prev !== null && next === null;

/**
 * One sentence in the seat's standing instructions, chosen by the answer. The
 * app composes those instructions itself (server/src/seat.ts), so a choice made
 * on the page reaches the chair without anybody editing a doctrine file.
 */
export const WHO_SENTENCE: Record<ReviewWho, string> = {
  never:
    "Who reviews and checks: you never read code and never run tests. Every change goes to a worker and reaches you as a report with its branch and its test log; you pass on a clean one, and a report that does not prove it green goes back.",
  second:
    "Who reviews and checks: the Reviewer reads the diff first; you then read the same diff as a second review before you pass it on, and your findings go back to the Builder.",
  is:
    "Who reviews and checks: you are the reviewer. Do the reading yourself rather than leaving it to the Reviewer: after the Builder reports, read the diff and the test log and send your findings back.",
};

/** The house block is composed after the doctrine, so this sentence is what
 *  decides when a person's own rules file says something else about evidence. */
export const REVIEW_OVERRIDES = "This project's answer, which overrides anything your rules file says about evidence";

export function reviewBrief(who: ReviewWho, rounds: number, second: SecondReviewer | null): string {
  const parts = [`${REVIEW_OVERRIDES}: ${WHO_SENTENCE[who]}`];
  parts.push(
    `The Builder and the Reviewer loop runs for at most ${rounds} round${rounds === 1 ? "" : "s"}; after that it stops and asks the person which findings to keep.`,
  );
  if (second) {
    const title = agentProvider(second.engine)?.title ?? second.engine;
    parts.push(`A second reviewer reads the same diff on ${title}${second.model ? ` (${second.model})` : " (its default model)"}; its findings join the first reviewer's.`);
  }
  return parts.join(" ");
}
