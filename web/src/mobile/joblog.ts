/**
 * A CI log, reduced to the part you came for.
 *
 * The Checks tab printed "The log itself lives on GitHub — the phone does not
 * download run logs" under every failure, while `jobLog` sat on the server and
 * `api.prJobLog` sat in the client. So "CI went red" — which is one of the Now
 * queue's four card kinds, and the one you are most likely to be woken by —
 * ended at a sentence telling you to go and use a browser.
 *
 * The reason not to just dump the text is real, though. A GitHub Actions log is
 * tens of thousands of lines, every one of them prefixed with a 28-character
 * ISO timestamp, and on a 390px screen that prefix alone eats most of the
 * width. What you want is the failure and the twenty lines before it.
 *
 * So: strip what is structure rather than content, find the failure, and show
 * around it — with the whole thing one tap away for the times the window is
 * wrong. Its own module, and the decisions are tested, because "which lines
 * matter" is exactly the kind of judgement that quietly stops being right.
 */

/** `2026-07-29T00:12:34.5678901Z ` — every line, and 28 characters of a 390px
 *  screen. It is the same for the whole log, so it carries nothing. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/;

/** Actions' own markers. `##[group]` and `##[endgroup]` are folding, which a
 *  phone has no use for; `##[error]` is the thing we are looking for. */
const GROUP = /^##\[(group|endgroup|section|debug)\]/;
const ERROR = /^##\[error\]/;

export interface LogWindow {
  lines: string[];
  /** Index within `lines` of the line the window was chosen for, or -1 when it
   *  is just the tail. */
  at: number;
  /** How many lines were left above. */
  hidden: number;
  /** Why this window and not another, in the user's words. */
  why: string;
}

export function stripStamp(line: string): string {
  return line.replace(STAMP, "");
}

/**
 * The log as lines worth showing: timestamps gone, folding markers gone,
 * trailing blanks gone.
 *
 * Blank lines in the middle stay — they are how a stack trace is separated from
 * the assertion above it, and collapsing them makes a log harder to read rather
 * than shorter in any way that matters.
 */
export function cleanLines(text: string): string[] {
  const out = text
    .split("\n")
    .map(stripStamp)
    .filter((l) => !GROUP.test(l))
    .map((l) => l.replace(/\r$/, ""));
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

/**
 * Where to open the log.
 *
 * The LAST `##[error]`, not the first: a run that fails, retries and fails
 * again reports the earlier one too, and the last is the one that ended the
 * job. Falling back to the tail is not a defeat — a job killed by a timeout or
 * an OOM never writes an error marker at all, and the last thing it managed to
 * say is exactly what you want.
 */
export function failureWindow(text: string, before = 24, after = 6): LogWindow {
  const lines = cleanLines(text);
  if (!lines.length) return { lines: [], at: -1, hidden: 0, why: "The log is empty" };

  let mark = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR.test(lines[i]!)) { mark = i; break; }
  }

  if (mark < 0) {
    const start = Math.max(0, lines.length - (before + after));
    return {
      lines: lines.slice(start),
      at: -1,
      hidden: start,
      why: start > 0 ? "No error was marked — the end of the log" : "The whole log",
    };
  }
  const start = Math.max(0, mark - before);
  const end = Math.min(lines.length, mark + 1 + after);
  return {
    lines: lines.slice(start, end),
    at: mark - start,
    hidden: start,
    why: start > 0 ? "Around the failure" : "The whole log",
  };
}

/**
 * The job behind a check.
 *
 * GitHub names a check run after its job, and names it `workflow / job` when a
 * workflow has several — so the check called `build` and the check called
 * `CI / build` are both the job `build`. Matched on the segment after the last
 * slash, trimmed, case-insensitively, because these are written by hand in YAML
 * and the casing is nobody's contract.
 *
 * A matrix job carries its parameters — `test (20.x, ubuntu-latest)` — and
 * those are part of the name on both sides, so they are left alone rather than
 * stripped: two matrix legs are two different jobs with two different logs, and
 * folding them would open the wrong one.
 */
export function jobFor<T extends { name: string }>(
  checkName: string, jobs: readonly T[],
): T | null {
  const norm = (s: string) => (s.split("/").pop() ?? s).trim().toLowerCase();
  const want = norm(checkName);
  if (!want) return null;
  const hits = jobs.filter((j) => norm(j.name) === want);
  // Exactly one. Two jobs of the same name in one pull request means the name
  // is not an identity here, and opening either is a guess.
  return hits.length === 1 ? hits[0]! : null;
}
