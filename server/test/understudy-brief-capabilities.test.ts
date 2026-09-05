/*
 * The brief has to name what the run can reach, and what it may refuse.
 *
 * MEASURED BEFORE THIS EXISTED: "skill" appeared twice in understudy-work.ts
 * and both were comments. The text an agent actually reads named none of the
 * person's skills, said nothing about the web, and its only line about
 * disagreement was "where their rules and yours disagree, follow theirs".
 *
 * So every run had his skills, his MCPs, a browser already signed in and web
 * search — and no reason to believe it. And it was told, in the one place the
 * subject came up, to defer.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/understudy-work.ts", import.meta.url)).text();
/** The strings the brief actually emits, with the reasoning stripped out. */
const spoken = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

describe("it is told what it can reach", () => {
  test("the skills are named, not gestured at", () => {
    // "use your skills" is not something an agent can act on. Five lines with
    // one rule each is.
    for (const skill of ["browser-use", "old-coder", "old-coder-api", "test-harness-html"]) {
      expect(spoken, `${skill} should be named in the brief`).toContain(skill);
    }
  });

  test("each one carries HIS rule for when to use it", () => {
    // Taken from how he uses them: the browser for a page behind a login,
    // never curl; the evidence-first loop for the high-stakes edges; the
    // harness for a card whose acceptance criteria have to be checked by hand.
    expect(spoken).toContain("already signed in");
    expect(spoken).toContain("never curl");
    expect(spoken).toMatch(/money, auth, data loss/);
    expect(spoken).toMatch(/acceptance criteria/);
  });

  test("and `scrum` is not one of them, on purpose", () => {
    /*
     * He has five skills and the brief names four. `scrum` posts his daily
     * standup, in his voice, to the channel his team reads — so it is fenced
     * off for the same reason the task tracker is. This is also why the list
     * is written out rather than read off the directory: a loader would name
     * it, and would bury these four under the twenty-odd plugin skills.
     */
    expect(spoken, "the brief must not offer to speak to his team as him").not.toContain("`scrum`");
  });

  test("the web comes second, and the repository first", () => {
    /*
     * His own rule, in his own words elsewhere: look at what is already there
     * before inventing. A brief that says "you may search" without that order
     * gets an agent googling a convention this codebase already has.
     */
    expect(spoken).toContain("the repository first, then the web");
    expect(spoken).toContain("Do not search");
  });
});

describe("it is allowed to say the task is wrong", () => {
  test("the brief says so, early and explicitly", () => {
    expect(spoken).toContain("IF THE TASK IS WRONG, SAY SO");
  });

  test("with the arithmetic that makes it worth doing", () => {
    // A run spent 45 minutes on a bad premise and delivered nothing. Saying so
    // in minute three would have been worth more than the other forty-two.
    expect(spoken).toMatch(/forty-five|45/i);
    expect(spoken).toContain("three minutes of");
  });

  test("and it may not agree with something it thinks is wrong", () => {
    expect(spoken).toContain("do not agree with a suggestion you think is wrong");
  });

  test("the deference that remains is about style, not about the task", () => {
    /*
     * The original line stays and is still right: where their conventions and
     * yours differ, follow theirs. That is what standing in for somebody
     * means. It is not a reason to build the wrong thing quietly.
     */
    expect(spoken).toContain("Where their rules and yours disagree, follow");
  });
});

describe("a vague task is turned into a sharp one", () => {
  /*
   * The common case, and the one the brief had no answer for. What arrives is
   * a sentence — "a plugin system", "an orchestrator", "make the UI better".
   *
   * Taken literally it produces a framework nobody asked for. Treated as a
   * reason to ask a question it produces nothing, because he is asleep. The
   * third way is the one he uses on himself: work out what the question really
   * was, from how he decides, and answer that.
   */
  test("the brief says to sharpen rather than ask or obey", () => {
    expect(spoken).toContain("IF THE TASK IS VAGUE, MAKE IT SHARPER");
    expect(spoken).toContain("do not ask, and do not take it");
  });

  test("with the owner's four tests for what a task is really asking", () => {
    // Drawn from the sessions in the bank, not invented: who gains, what
    // already exists, what can be measured, and what is decoration.
    expect(spoken).toContain("what does somebody GAIN");
    expect(spoken).toContain("The owner looks before they");
    expect(spoken).toContain("smallest version that can be MEASURED");
    expect(spoken).toContain("which part is decoration");
  });

  test("and it has to say out loud what it decided the task was", () => {
    /*
     * The check on the whole idea. An agent that reinterprets silently is
     * worse than one that obeys literally, because nobody can tell which
     * happened until the diff is read.
     */
    expect(spoken).toContain("what you decided the task actually was");
    expect(spoken).toContain("getting it wrong silently is not");
  });
});
