/*
 * A thumb must not be able to do something irreversible in one tap.
 *
 * The phone companion inherited the desktop's action set, where every one of
 * these lives behind a pointer, a hover title and a screen wide enough to show
 * what is selected. On a phone none of that holds: the button is under the
 * thumb that is already scrolling, and the thing it acts on is usually off
 * screen — the file is behind a diff, the container behind a stats card, the
 * branch not rendered at all. `api.gitDiscard` fired on touch-down with no
 * question and nothing named.
 *
 * These are asserted against the source rather than driven through the UI on
 * purpose. A click-through test would have to reach each screen through the
 * demo fixture, which does not contain a mergeable pull request — so the merge
 * confirm, the most expensive of the four, is the one a UI test would silently
 * skip. Reading the call site cannot skip it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..", "web", "src", "mobile");
const read = (f: string) => readFileSync(join(WEB, f), "utf8");

/**
 * The four calls that cannot be taken back, and the file each lives in.
 *
 * Not an exhaustive list of mobile writes — stage, restart, stop, approve and
 * re-run are all one tap on purpose, because each of them is undone by another
 * tap. The line is reversibility, not danger.
 */
const IRREVERSIBLE: { file: string; call: string; what: string }[] = [
  { file: "MobileRepo.tsx", call: "api.gitDiscard(", what: "discarding a file's changes" },
  { file: "MobileRepo.tsx", call: "api.dockerRm(", what: "removing a container" },
  { file: "MobilePr.tsx", call: "api.prClose(", what: "closing a pull request" },
  { file: "MobilePr.tsx", call: "api.prMerge(", what: "squash-merging and deleting the branch" },
  { file: "MobileApp.tsx", call: "api.prMerge(", what: "squash-merging from the Now queue" },
];

/** The `confirm({...})` call this one sits inside, if any. Walks back from the
 *  call to the nearest enclosing `confirm(` — a `run:` property inside a spec
 *  is confirmed; the same call in a bare `onAct` is not. */
function confirmedSpec(src: string, at: number): string | null {
  const open = src.lastIndexOf("confirm({", at);
  if (open === -1) return null;
  // Balance braces from the spec's `{` to make sure `at` is really inside it
  // and not after a spec that closed earlier in the same handler.
  let depth = 0;
  for (let i = src.indexOf("{", open); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i > at ? src.slice(open, i + 1) : null;
    }
  }
  return null;
}

describe("the phone asks before it does something irreversible", () => {
  for (const { file, call, what } of IRREVERSIBLE) {
    test(`${what} goes through a confirm`, () => {
      const src = read(file);
      const at = src.indexOf(call);
      expect(at, `${call} not found in ${file} — the call moved, so this guard is now watching nothing`).toBeGreaterThan(-1);

      const spec = confirmedSpec(src, at);
      expect(spec, `${file}: ${call} is reachable in one tap`).not.toBeNull();

      // A confirm that says only "Are you sure?" is worse than none — it
      // trains the thumb to dismiss it. The spec has to name what it is about
      // to touch and say what does not come back.
      expect(spec).toContain("verb:");
      expect(spec).toContain("subject:");
      expect(spec).toContain("warn:");
    });
  }

  test("the subject is read from scope, never a fixed string", () => {
    // "Discard the file?" is the failure this catches. The whole reason the
    // sheet exists is that the person cannot see which file, container or PR
    // is selected — so a hardcoded noun confirms nothing. Anything evaluated
    // counts: a template literal, a variable, `rel(paths[diffAt]!)`. What does
    // not count is a quoted constant.
    const LITERAL = /^\s*(["'])(?:(?!\1).)*\1\s*$/;
    for (const { file, call } of IRREVERSIBLE) {
      const src = read(file);
      const spec = confirmedSpec(src, src.indexOf(call))!;
      const subject = spec.match(/subject:\s*([^,\n]+)/)?.[1] ?? "";
      expect(subject.trim(), `${file}: ${call} has no subject at all`).not.toBe("");
      expect(LITERAL.test(subject), `${file}: ${call} names a fixed subject — ${subject}`).toBe(false);
    }
  });

  test("reversible actions are left alone", () => {
    // The guard above is only meaningful if it is not applied to everything.
    // Staging and restarting are one tap by design; a confirm on them would
    // make the confirms themselves noise.
    const repo = read("MobileRepo.tsx");
    for (const call of ["api.gitStage(", "api.dockerRestart(", "api.dockerStop("]) {
      expect(confirmedSpec(repo, repo.indexOf(call)), `${call} should stay one tap`).toBeNull();
    }
  });
});
