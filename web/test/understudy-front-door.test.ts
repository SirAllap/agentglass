/**
 * The panel has to say where to start.
 *
 * His words, opening it: "none of the 3 tabs make sense, they are full of
 * overwhelming info, and you don't want to touch anything in case it breaks". He commissioned
 * the feature — if it does not tell him where to begin, it tells nobody.
 *
 * The three tabs are three real jobs, and they read left to right in the
 * REVERSE of the order they are used in: teach it, check it, then hand it work.
 * The work tab is the one that opens, so a first visit lands on the last step.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { onboarding } from "../src/components/understudy/Work.tsx";

const fresh = { precedents: 0, rules: 0, runsDone: 0, asked: false };

describe("the first-run line", () => {
  test("a machine taught nothing is sent to teach it, not to the work tab", () => {
    const ob = onboarding(fresh)!;
    expect(ob.step).toBe(1);
    expect(ob.goes, "the tab that opens is the last step of three").toBe("teach");
    expect(ob.does).toBe("Show it a repository");
    // The sentence people need before pointing a machine at their code.
    expect(ob.why).toContain("Nothing leaves this machine");
  });

  test("taught but never asked: check its judgement before handing it work", () => {
    const ob = onboarding({ ...fresh, precedents: 120 })!;
    expect(ob.step).toBe(2);
    expect(ob.goes).toBe("ask");
  });

  test("rules alone count as taught — a person can write rules without a corpus", () => {
    expect(onboarding({ ...fresh, rules: 3 })!.step).toBe(2);
  });

  test("taught and asked: now the work tab, and the button lands in the box", () => {
    const ob = onboarding({ ...fresh, precedents: 120, asked: true })!;
    expect(ob.step).toBe(3);
    expect(ob.goes).toBe("work");
    expect(ob.why, "the promise that matters most").toContain("nothing is ever pushed");
  });

  test("one finished run and the line is GONE, for good", () => {
    expect(onboarding({ precedents: 120, rules: 3, runsDone: 1, asked: true }),
      "a wizard that will not leave is worse than no wizard").toBeNull();
    // …even for somebody who never used the other tabs at all.
    expect(onboarding({ ...fresh, runsDone: 1 })).toBeNull();
  });

  test("every step names one action, and it is a thing a person does", () => {
    for (const s of [fresh, { ...fresh, precedents: 1 }, { ...fresh, precedents: 1, asked: true }]) {
      const ob = onboarding(s)!;
      expect(ob.does.length, `step ${ob.step} has no button`).toBeGreaterThan(3);
      expect(ob.title[0]).toBe(ob.title[0]!.toUpperCase());
    }
  });
});

describe("the tab strip", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/UnderstudyPanel.tsx", import.meta.url), "utf8");

  test("the tabs are named for what you do, not for the machinery", () => {
    const at = SRC.indexOf('label="What to show"');
    /* To the end of the options array, not a fixed number of characters: the
       note explaining WHY they were renamed sits between the two, and a window
       that stops short reads as a rename that never happened. */
    const opts = SRC.slice(at, SRC.indexOf("onChange={setTab}", at));
    expect(opts).toContain('label: "Its work"');
    expect(opts).toContain('label: "Try it"');
    expect(opts).toContain('label: "What it knows"');
  });

  test("a raised hand is visible WITHOUT opening a tab", () => {
    /* 26 of 108 runs delivered nothing and not one said what it needed. The
       first version of "it asks for help" has to be impossible to walk past. */
    expect(SRC).toContain("waiting on you");
    expect(SRC, "it has to come from the count the header already fetches").toContain("standing?.stuck");
  });

  test("and clicking it goes to where the question is", () => {
    const at = SRC.indexOf("waiting on you");
    const chip = SRC.slice(Math.max(0, at - 700), at + 120);
    expect(chip).toContain('setTab("work")');
  });
});

/**
 * The other two tabs, held to the same rule: one thing to do, the settings out
 * of the way until somebody wants them.
 *
 * "They are full of overwhelming info, and you don't want to touch anything in
 * case it breaks" was said about all three, not only about the work tab.
 */
describe("try it", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/Ask.tsx", import.meta.url), "utf8");

  test("the examples come before the settings, not after them", () => {
    /* They are the only control on that screen a stranger can use, and they
       were last — under two rows of choices nobody can make before they have
       seen a single answer. */
    const examples = SRC.indexOf("EXAMPLES.map");
    const sides = SRC.indexOf("SIDES.map");
    expect(examples).toBeGreaterThan(-1);
    expect(examples, "the one usable control was below the two unusable ones").toBeLessThan(sides);
  });

  test("what it reads is folded, and the fold says where it stands", () => {
    expect(SRC).toContain("setTuning");
    expect(SRC, "a closed fold that does not say its state is a hidden setting").toContain("reading:");
  });

  test("the reading switch folds with it — same row, same decision", () => {
    expect(SRC).toContain("{tuning && judge.available && (");
  });
});

describe("what it knows", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/Teach.tsx", import.meta.url), "utf8");

  test("one sentence beside the button, the proof behind a link", () => {
    /* Six lines of dense reasoning sat between a person and the button they
       had just been told to press. All of it correct, none of it answering a
       question anybody had asked yet. */
    const at = SRC.indexOf("Set this up for me</Chip>");
    const near = SRC.slice(at, at + 1400);
    expect(near).toContain("Nothing leaves it.");
    expect(near).toContain("what exactly does it read?");
  });

  test("and the detail is still there for whoever wants it", () => {
    expect(SRC, "folding must not mean deleting the reasoning").toContain("Reading is not the risk");
    expect(SRC).toContain("{why && (");
  });
});

/**
 * A button that reads as text must not decide how big that text is.
 *
 * `.agx-linkish` declared `font: inherit`, and the shorthand resets every font
 * property — size included. Every place that set a size with a utility class
 * lost to it, so "reading: Open project" rendered at the container's own 20px
 * and read as a heading. Found by looking at the screen; no test that reads
 * source could have caught it, so this one reads the stylesheet.
 */
test("the link-shaped button does not reset its own font size", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const at = css.indexOf(".agx-linkish {");
  expect(at).toBeGreaterThan(-1);
  /* Declarations only: the note explaining the fix names the thing it forbids,
     and a rule that reads its own comments fails on the explanation. */
  const rule = css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(rule, "the shorthand takes font-size with it").not.toMatch(/font:\s*inherit/);
  expect(rule).toContain("font-family: inherit");
});

test("try it teaches the tab in the space where the answer will go", () => {
  /* Rendered at 1950x1422: a box, four chips, and then a thousand pixels of
     nothing. Somebody who has not pressed Ask has no idea what pressing it
     produces, and empty space does not tell them. */
  const SRC = readFileSync(new URL("../src/components/understudy/Ask.tsx", import.meta.url), "utf8");
  expect(SRC).toContain("What comes back is not an opinion");
  expect(SRC, "the honest half — it does not invent a position").toContain("says so instead");
  // And it goes when there IS an answer to show.
  const at = SRC.indexOf("What comes back is not an opinion");
  expect(SRC.slice(Math.max(0, at - 400), at)).toContain("{!answer && !busy && (");
});

test("the fence says it is the fence, not a count of checkouts", () => {
  /* Asked, looking at the panel: "where is that setting that limits it to
     agentglass only?" — it was on screen, rendered as "3 checkouts · change" in
     grey. That is a status line. This setting decides where a machine may
     write, and it is also the one thing the panel cannot infer for somebody:
     unset, it takes the checkout the server runs from. */
  const SRC = readFileSync(new URL("../src/components/understudy/Work.tsx", import.meta.url), "utf8");
  expect(SRC).toContain("may work in: ");
  expect(SRC, "an unset fence must look unset, not empty").toContain('"(not set)"');
  // The hover still lists the checkouts it resolves to — the count was not
  // useless, it was just not the headline.
  expect(SRC).toContain("It may only work inside");
});
