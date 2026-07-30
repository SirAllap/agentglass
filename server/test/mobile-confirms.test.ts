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
 * Asserted against the source rather than driven through the UI on purpose.
 * A click-through test has to reach each screen through the demo fixture,
 * which contains no mergeable pull request and no containers — so it would
 * have driven two of the five and passed silently on the rest, including
 * squash-merge-and-delete-branch, the most expensive of the set. Reading the
 * call site cannot skip one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..", "web", "src", "mobile");
const read = (f: string) => readFileSync(join(WEB, f), "utf8");

/**
 * The calls that cannot be taken back, and the file each lives in.
 *
 * Not an exhaustive list of mobile writes — stage, restart, stop, approve and
 * re-run are all one tap on purpose, because each is undone by another tap.
 * The line is reversibility, not danger.
 */
const IRREVERSIBLE: { file: string; call: string; what: string }[] = [
  { file: "MobileRepo.tsx", call: "api.gitDiscard(", what: "discarding a file's changes" },
  { file: "MobileRepo.tsx", call: "api.dockerRm(", what: "removing a container" },
  { file: "MobilePr.tsx", call: "api.prClose(", what: "closing a pull request" },
  { file: "MobilePr.tsx", call: "api.prMerge(", what: "squash-merging and deleting the branch" },
];

/**
 * Calls that may not appear in a file at all, confirm or no confirm.
 *
 * A confirm is a fine control on a screen you navigated to on purpose: the
 * pull request is in front of you, with its diff, its checks and its threads,
 * and the dialog is the last step of a decision you were already making.
 *
 * It is a poor one in the Now queue, which is a scrolling list where every
 * card puts its buttons in the same shape and the same place. There, the
 * dialog appears under the thumb that just tapped. `MobileApp.tsx` owns that
 * queue, so the rule for it is not "ask first" but "do not offer".
 */
const NEVER: { file: string; call: string; what: string }[] = [
  { file: "MobileApp.tsx", call: "api.prMerge(", what: "merging from a card in the queue" },
  { file: "MobileApp.tsx", call: "api.prClose(", what: "closing a pull request from the queue" },
  { file: "MobileApp.tsx", call: "api.dockerRm(", what: "removing a container from the queue" },
  { file: "MobileApp.tsx", call: "api.gitDiscard(", what: "discarding changes from the queue" },
];

/**
 * The `ask({…})` spec guarding this call, if there is one.
 *
 * The shape under test is the same one the desktop panels use:
 *
 *   if (!(await ask({ … }))) return;
 *   await api.whatever(…)
 *
 * so the guard is the nearest preceding `await ask({`, and the call has to
 * come after that spec closes. Moving the write into a *different* handler
 * after the guard breaks the pairing, which is why the span between them is
 * checked for another handler opening.
 */
function askedFirst(src: string, at: number): string | null {
  const open = src.lastIndexOf("await ask({", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", open); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      if (i > at) return null; // the call is inside the spec, not after it
      const between = src.slice(i, at);
      return /onAct=|run:\s*(async\s*)?\(/.test(between) ? null : src.slice(open, i + 1);
    }
  }
  return null;
}

describe("the phone asks before it does something irreversible", () => {
  for (const { file, call, what } of IRREVERSIBLE) {
    test(`${what} goes through ask()`, () => {
      const src = read(file);
      const at = src.indexOf(call);
      expect(at, `${call} is not in ${file} — the call moved, so this guard now watches nothing`).toBeGreaterThan(-1);

      const spec = askedFirst(src, at);
      expect(spec, `${file}: ${call} is reachable in one tap`).not.toBeNull();

      // A question that says only "Are you sure?" is worse than none — it
      // trains the thumb to dismiss it. The spec has to carry the sentence
      // about what does not come back, and paint the button red.
      expect(spec).toContain("title:");
      expect(spec).toContain("body:");
      expect(spec).toContain("danger: true");
    });
  }

  test("the title names the actual subject, read from scope", () => {
    // "Discard the file?" is the failure this catches. The whole reason the
    // sheet exists is that the person cannot see which file, container or PR
    // is selected — so a hardcoded noun confirms nothing. Anything evaluated
    // counts: a template literal, a variable, `rel(paths[diffAt]!)`. What does
    // not count is a quoted constant.
    const LITERAL = /^\s*(["'])(?:(?!\1).)*\1\s*$/;
    for (const { file, call } of IRREVERSIBLE) {
      const src = read(file);
      const spec = askedFirst(src, src.indexOf(call))!;
      const title = spec.match(/title:\s*([^,\n]+)/)?.[1] ?? "";
      expect(title.trim(), `${file}: ${call} has no title at all`).not.toBe("");
      expect(LITERAL.test(title), `${file}: ${call} asks a fixed question — ${title}`).toBe(false);
    }
  });

  test("the queue offers nothing irreversible, confirm or no confirm", () => {
    // Stronger than "ask first", and a different rule for a different surface.
    // This used to be an `ask()` guard on a Squash & merge in the queue; the
    // guard was real and the button was still wrong, because the queue is a
    // scrolling list and a confirm appears under the thumb that just tapped.
    for (const { file, call, what } of NEVER) {
      expect(read(file).includes(call), `${file} offers ${what}`).toBe(false);
    }
  });

  test("and the shell has not simply been emptied", () => {
    // The rule above passes trivially against a file that calls nothing, so
    // pin the writes the queue legitimately makes: a re-run and a restart are
    // both undone by doing them again, and a gate decision is the answer the
    // agent is stopped waiting for.
    const shell = read("MobileApp.tsx");
    for (const call of ["api.prRerun(", "api.dockerRestart(", "api.gateDecide("]) {
      expect(shell.includes(call), `the queue should still offer ${call}`).toBe(true);
    }
  });

  test("reversible actions are left alone", () => {
    // The guard above is only meaningful if it is not applied to everything.
    // Staging and restarting are one tap by design; a question on those would
    // turn every question on this screen into noise.
    const repo = read("MobileRepo.tsx");
    for (const call of ["api.gitStage(", "api.dockerRestart(", "api.dockerStop("]) {
      expect(askedFirst(repo, repo.indexOf(call)), `${call} should stay one tap`).toBeNull();
    }
  });

  test("the phone uses the app's own dialog contract, not a second one", () => {
    // web/test/no-native-dialogs.test.ts bans window.confirm across web/src.
    // A phone-shaped confirm is still legitimate — a centred modal ignores the
    // back gesture and lands nowhere near the thumb — but it has to BE the
    // desktop's contract in a different surface, not a rival vocabulary.
    const ui = readFileSync(join(WEB, "mobileUi.tsx"), "utf8");
    expect(ui).toContain('import type { ConfirmSpec } from "../components/ConfirmDialog.tsx"');
    expect(ui).toContain("Promise<boolean>");
  });
});
