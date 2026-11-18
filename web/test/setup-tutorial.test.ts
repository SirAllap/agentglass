/*
 * The five tour steps, their seen list, where each one points, and the offer.
 *
 * There is no DOM harness: the table is asserted through the pure helpers, and
 * the two controls that must NOT write are read from the dialog's source, where
 * the close path is the one function that calls neither save nor mark.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TUTORIAL_CARDS, cardAfter, cardsLeft, markAllSeen, markSeen, resumeIndex, seenCards, stepPlan,
  tourProgress, tourSteps, tutorialOffer,
} from "../src/lib/setupTutorial.ts";

describe("the five steps", () => {
  test("are the mock's, in its order, each on a real selector", () => {
    expect(TUTORIAL_CARDS.map((c) => c.title)).toEqual([
      "Terminal tabs", "Pull requests", "Jira cards", "Browser", "Flight plan",
    ]);
    expect(TUTORIAL_CARDS.map((c) => c.target)).toEqual([
      '[data-view="term"]', '[data-view="pr"]', '[role="tree"][aria-label="Jira spaces"]',
      '[data-view="browser"]', '[data-view="flightPlan"]',
    ]);
  });

  test("Next leaves the current step and nothing else", () => {
    expect(markSeen("", "term")).toBe("term");
    expect(markSeen("term", "pr")).toBe("term,pr");
    // Leaving a step already seen changes no order.
    expect(markSeen("pr,term", "term")).toBe("term,pr");
  });

  test("the last step's Next is Done: there is no step after it", () => {
    expect(cardAfter("term")).toBe("pr");
    expect(cardAfter("flightPlan")).toBeNull();
  });

  test("all seen is all five, in their order", () => {
    const all = markAllSeen();
    expect(all).toBe("term,pr,jira,browser,flightPlan");
    expect(cardsLeft(all)).toBe(0);
  });

  test("a stored list survives a reload, and an old card id is ignored", () => {
    expect(seenCards("term,polaris,jira")).toEqual(["term", "jira"]);
    expect(cardsLeft("term,jira")).toBe(3);
  });
});

describe("where a step points", () => {
  const env = { browser: true, jira: true, view: "term" as const };
  const step = (id: string) => TUTORIAL_CARDS.find((c) => c.id === id)!;

  test("on screen already: no switch, the hole on its target", () => {
    expect(stepPlan(step("term"), env)).toMatchObject({ switchTo: null, target: '[data-view="term"]', settings: null });
  });

  test("not on screen: switch to its view first", () => {
    expect(stepPlan(step("pr"), env).switchTo).toBe("pr");
    expect(stepPlan(step("jira"), env).switchTo).toBe("tasks");
    expect(stepPlan(step("jira"), { ...env, view: "tasks" }).switchTo).toBeNull();
  });

  test("no Jira: no switch, no hole, and Settings ▸ Connections instead", () => {
    const p = stepPlan(step("jira"), { ...env, jira: false });
    expect(p).toMatchObject({ switchTo: null, target: null, settings: "connections" });
    expect(p.body.join(" ")).toContain("Settings ▸ Connections");
  });

  test("the Browser step drops out when its view is off", () => {
    expect(tourSteps({ browser: false }).map((c) => c.id)).toEqual(["term", "pr", "jira", "flightPlan"]);
    expect(tourSteps({ browser: true })).toHaveLength(5);
    expect(cardAfter("jira", tourSteps({ browser: false }))).toBe("flightPlan");
  });
});

describe("resume", () => {
  test("opens the first step not seen, and the first when all are", () => {
    expect(resumeIndex("")).toBe(0);
    expect(resumeIndex("term,pr")).toBe(2);
    expect(resumeIndex("term,jira")).toBe(1);
    expect(resumeIndex(markAllSeen())).toBe(0);
  });

  test("counts only the steps this app shows", () => {
    const four = tourSteps({ browser: false });
    expect(resumeIndex("term,pr,jira", four)).toBe(3);
    expect(tourProgress("term,pr,jira,flightPlan", four)).toMatchObject({ done: true, line: "All 4 seen" });
  });

  test("the About line says how far and where it stopped", () => {
    expect(tourProgress("")).toMatchObject({ line: "Not started", resumeAt: 0, done: false });
    expect(tourProgress("term,pr")).toMatchObject({ line: "2 of 5 seen · stopped at Jira cards", resumeAt: 2, done: false });
    expect(tourProgress(markAllSeen())).toMatchObject({ line: "All 5 seen", done: true });
  });
});

describe("the offer", () => {
  test("counts the cards left and names them", () => {
    expect(tutorialOffer("")).toMatchObject({ left: 5, title: "Setup finished · 5 steps left" });
    expect(tutorialOffer("term,pr,jira")).toMatchObject({ left: 2, title: "Setup finished · 2 steps left" });
    expect(tutorialOffer("term,pr,jira,browser")).toMatchObject({ left: 1, title: "Setup finished · 1 step left" });
  });

  test("is absent at five", () => {
    expect(tutorialOffer(markAllSeen())).toBeNull();
  });

  test("the small size never paints a primary's fill over its own ink", async () => {
    // The offer's Show me pairs these two, and a later background in the small
    // rule drew it white on #eee (1.16:1).
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    const painted = [...css.matchAll(/([^\n{}]*\.setup-btn-xs[^\n{}]*)\{([^}]*)\}/g)]
      .filter(([, sel]) => !sel!.includes(":not(.setup-btn-primary)"))
      .filter(([, , body]) => /background|box-shadow/.test(body!));
    expect(painted.map((m) => m[1]!.trim())).toEqual([]);
  });
});

describe("focus", () => {
  const src = readFileSync(new URL("../src/components/setup/Tutorial.tsx", import.meta.url), "utf8");

  test("Next takes focus again once the card is drawn, not only on open", () => {
    expect(src).toContain("const drawn = plan != null;");
    expect(src).toMatch(/next\.current\?\.focus\(\);[\s\S]*?\}, \[open, at, drawn\]\);/);
  });

  test("closing gives focus back to what had it", () => {
    expect(src).toMatch(/const before = document\.activeElement[\s\S]*?before\.focus\(\)[\s\S]*?\}, \[open\]\);/);
  });
});

describe("the Finish offer counts the steps the tour shows", () => {
  test("Browser off: four seen leaves none, though the five-step count says one", () => {
    const four = tourSteps({ browser: false });
    expect(four.length).toBe(TUTORIAL_CARDS.length - 1);
    const stored = TUTORIAL_CARDS.filter((c) => c.id !== "browser").map((c) => c.id).join(",");
    expect(tutorialOffer(stored, four)).toBeNull();
    expect(tutorialOffer(stored)).not.toBeNull();
  });

  test("App and SetupOffer ask the same filtered count", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const tour = readFileSync(new URL("../src/components/setup/Tutorial.tsx", import.meta.url), "utf8");
    expect(app).toContain("const left = setupOfferNow(tutorialSeen) != null;");
    expect(app).not.toMatch(/tutorialOffer\(tutorialSeen\)/);
    expect(tour).toContain("const offer = setupOfferNow(seen);");
    expect(tour).toContain("tutorialOffer(seen, tourNow())");
  });
});

describe("what closes and writes nothing", () => {
  const src = readFileSync(new URL("../src/components/setup/Tutorial.tsx", import.meta.url), "utf8");

  test("the close path is one function and it writes nothing", () => {
    const shut = src.slice(src.indexOf("const shut ="), src.indexOf("useEffect(() => {\n    if (!open)"));
    expect(shut).not.toContain("saveSeen");
    expect(shut).not.toContain("markSeen");
    expect(shut).not.toContain("settingsDoorSet");
    expect(shut).toContain("closeTutorial()");
  });

  test("Escape closes this dialog, and Not now has no write either", () => {
    expect(src).toContain('if (e.key !== "Escape") return;');
    expect(src).toContain("shut();");
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("<SetupOffer");
    const offer = src.slice(src.indexOf("export function SetupOffer"), src.indexOf("function X()"));
    expect(offer).not.toContain("saveSeen");
  });

  test("the coach is a dialog, named with its step, and never uses title=", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain("aria-label={`Tour, step ${at + 1} of ${steps.length}`}");
    expect(src).not.toMatch(/\stitle=/);
  });
});

describe("tour steps follow the rail (setup walk Q106)", () => {
  test("a step whose view is off the rail drops out, with the rest in order", () => {
    const ids = tourSteps({ browser: true, shown: (v) => v !== "pr" && v !== "flightPlan" }).map((c) => c.id);
    expect(ids).toEqual(["term", "jira", "browser"]);
  });
  test("every view off the rail keeps the tour whole", () => {
    expect(tourSteps({ browser: false, shown: () => false })).toHaveLength(4);
  });
});
