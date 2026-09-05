/**
 * Where the user-facing prose is, for the tests that pin a promise to it.
 *
 * Several tests in here lock a claim the documentation makes against the code
 * that has to keep it true — the retention default, what an alert can do on a
 * phone, which exporters the OTLP route accepts. Each of them used to read
 * `README.md` directly, because for a long time that file was the whole of the
 * documentation: 1,343 lines, everything in one place.
 *
 * When the README was cut down to a front door and the detail moved into
 * `docs/`, all three went red — not because a promise had changed, but because
 * the paragraph carrying it had moved one file to the left. That is a bad
 * failure mode for a tripwire: it cries about the filing and stays quiet about
 * the thing it was built to watch.
 *
 * So these helpers look for the claim across the whole of the prose rather than
 * at one path. A section that moves again keeps its lock; a section that is
 * deleted still fails, which is the case worth failing on.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** README, then the docs pages, then the release history — every file a reader
 *  can reach from the front door. Sorted so a failure message lists them in a
 *  stable order rather than in whatever order the filesystem felt like. */
export function docPaths(): string[] {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `docs/${f}`);
  return ["README.md", ...docs, "CHANGELOG.md"];
}

/** Every documentation file, as `{ path, text }`. */
export function allDocs(): { path: string; text: string }[] {
  return docPaths().map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

/**
 * The one documentation file containing `marker`, or a thrown error naming
 * every file that was searched.
 *
 * Throws rather than returning null on purpose: a caller that cannot find the
 * paragraph it is about to make assertions on has nothing useful left to do,
 * and the message it gets ("the retention table is in none of README.md,
 * docs/CONFIG.md, …") is the one that tells a maintainer whether prose was
 * moved or deleted.
 */
export function docContaining(marker: string, what = marker): { path: string; text: string } {
  const hit = allDocs().find((d) => d.text.includes(marker));
  if (!hit) throw new Error(`${what} is in none of ${docPaths().join(", ")} — was it moved, or deleted?`);
  return hit;
}

/**
 * The slice of documentation between two headings, wherever it now lives.
 *
 * Both headings have to be in the same file, in order. That constraint is the
 * point: it is what stops a mention of the same words somewhere else in the
 * documentation from satisfying a check about what one particular section says.
 */
export function docSection(startHeading: string, endHeading: string): string {
  const { path, text } = docContaining(startHeading, `the section "${startHeading}"`);
  const from = text.indexOf(startHeading);
  const to = text.indexOf(endHeading, from);
  if (to < 0) throw new Error(`"${endHeading}" no longer follows "${startHeading}" in ${path}`);
  return text.slice(from, to);
}
