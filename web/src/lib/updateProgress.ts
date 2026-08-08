/*
 * Where an update has got to, read from the log it already writes.
 *
 * The update script marks each phase with `==> `, and `/update/log` hands back
 * the file. So progress is not invented here and there is no second channel to
 * keep in step with the first: the thing doing the work is the thing being
 * read.
 *
 * Matched on the STABLE part of each line rather than the whole sentence. Those
 * lines carry a tag, a short sha and a path, and a matcher that wanted the
 * whole thing would break the first time somebody reworded one — silently,
 * which is the worst way for a progress bar to fail.
 */

export interface Phase {
  id: string;
  /** What the person is told. Present tense: it is happening now. */
  label: string;
  /** Substring that identifies this phase in the log, lower-cased. */
  match: RegExp;
}

/**
 * The five steps, in the order the script performs them.
 *
 * `cloning` and `updating the clone` are one step with two spellings — the
 * first update clones and every later one fetches — and they are worth telling
 * apart in the sentence, not in the count.
 */
export const PHASES: Phase[] = [
  { id: "fetch", label: "Fetching the code", match: /cloning|updating the update clone/ },
  { id: "checkout", label: "Switching to the new version", match: /checking out/ },
  { id: "deps", label: "Installing dependencies", match: /installing dependencies/ },
  { id: "build", label: "Building and installing", match: /building and installing/ },
  { id: "relaunch", label: "Reopening", match: /relaunching|done — running|done - running/ },
];

/** The step at which this app is stopped. Everything after it happens while
 *  nothing is on screen to show it, which is a fact the UI has to state rather
 *  than a bar it can fill. */
export const CLOSES_AT = PHASES.findIndex((p) => p.id === "build");

export interface Progress {
  /** How many phases have been entered, 0..PHASES.length. */
  reached: number;
  /** The one happening now, or null before the first line arrives. */
  current: Phase | null;
  /** True when the log shows the first-ever clone, which is much slower. */
  firstTime: boolean;
  /** The script failed and said so. */
  failed: boolean;
  /** The last few lines, for a failure worth showing. */
  tail: string;
}

/**
 * Read a log into a position.
 *
 * Highest phase seen WINS, rather than the last line matched. Output is not
 * strictly ordered — a build prints thousands of lines and one of them may
 * happen to contain an earlier phrase — and a bar that goes backwards is worse
 * than one that is slightly ahead.
 */
export function readProgress(text: string): Progress {
  const lower = (text || "").toLowerCase();
  let reached = 0;
  for (let i = 0; i < PHASES.length; i++) {
    if (PHASES[i]!.match.test(lower)) reached = i + 1;
  }
  const lines = (text || "").split("\n").filter((l) => l.trim());
  return {
    reached,
    current: reached > 0 ? PHASES[reached - 1]! : null,
    firstTime: /cloning/.test(lower),
    // `error`/`failed` alone would match the output of a passing test suite, so
    // only the script's own last word counts.
    failed: /\bupdate failed\b|^failed\b/m.test(lower),
    tail: lines.slice(-6).join("\n"),
  };
}

/** A fraction for the bar. Never 1: the app is stopped before the last step, so
 *  a full bar would be a claim nothing on screen can make. */
export function fraction(p: Progress): number {
  if (!p.reached) return 0.04;
  return Math.min(p.reached / PHASES.length, (CLOSES_AT + 1) / PHASES.length);
}

/** `1:12`, for a run that has no total to count down from. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
