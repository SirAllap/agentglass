/*
 * What the Now queue is allowed to do to you.
 *
 * The queue is a vertically scrolling list of cards, every one of which puts
 * its actions in the same shape and the same place. That is the whole point —
 * you thumb down it and answer things — and it is exactly why an irreversible
 * action must not be one of them. "Squash & merge" sat there for a while, with
 * a danger-styled confirm in front of it, and a confirm is the weakest control
 * there is against a mis-tap: it appears under the thumb that just tapped.
 *
 * A rule over the file rather than an assertion about today's switch
 * statement. `actionsFor` is a closure over component state and cannot be
 * imported, and pinning the labels it returns would only say what the cards
 * say today — it would not stop somebody adding a fifth verb tomorrow. What
 * has to stay true is smaller and more durable: the shell that owns the queue
 * calls nothing that cannot be taken back.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SHELL = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url).pathname, "utf8");

/**
 * Calls that finish, destroy or rewrite something, where the phone is the
 * worst possible place to be asked.
 *
 * Not a list of everything that writes. `prRerun` re-runs checks, `dockerRestart`
 * restarts a container, and both are recoverable by doing them again. Merging
 * deletes a branch, closing rejects somebody's work, removing a container takes
 * its filesystem, and discarding throws away edits nobody has committed.
 */
const IRREVERSIBLE = [
  "prMerge",
  "prClose",
  "dockerRm",
  "gitDiscard",
  "gitReset",
];

describe("the phone's queue", () => {
  it("offers nothing that cannot be taken back", () => {
    for (const call of IRREVERSIBLE) {
      expect(SHELL).not.toContain(`api.${call}(`);
    }
  });

  it("still offers the ones that are only a repeat", () => {
    // The rule above has to be a real constraint rather than a description of
    // an empty file: these are the writes the queue legitimately makes, and if
    // they vanish this test is passing for the wrong reason.
    expect(SHELL).toContain("api.prRerun(");
    expect(SHELL).toContain("api.dockerRestart(");
    // And the one the queue exists for. A gate decision is not reversible
    // either, but it is the decision the agent is stopped waiting for — the
    // queue is the right place to be asked, which is the whole distinction.
    expect(SHELL).toContain("api.gateDecide(");
  });

  it("sends a ready pull request to the screen that can show the change", () => {
    // Merging is a decision you make looking at the diff, the checks and the
    // threads, all of which are one screen away.
    const readyCase = SHELL.slice(SHELL.indexOf('case "pr-ready":'), SHELL.indexOf('case "pr-review":'));
    expect(readyCase).toContain("setOpenPr");
    // It navigates and snoozes, and calls no server route at all — which is a
    // stronger thing to say than "it does not merge", and does not go stale
    // the moment somebody invents a second way to finish a pull request.
    expect(readyCase).not.toMatch(/\bapi\.\w+\(/);
  });
});
