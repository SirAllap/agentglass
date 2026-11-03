/*
 * The five cards, their seen list and the offer.
 *
 * There is no DOM harness: the table is asserted through the pure helpers, and
 * the two controls that must NOT write are read from the dialog's source, where
 * the close path is the one function that calls neither save nor mark.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TUTORIAL_CARDS, cardAfter, cardsLeft, markAllSeen, markSeen, seenCards, tutorialOffer,
} from "../src/lib/setupTutorial.ts";

describe("the five cards", () => {
  test("are the mock's, in its order", () => {
    expect(TUTORIAL_CARDS.map((c) => c.title)).toEqual([
      "The terminal", "Pull requests", "Tasks", "Agents and orchestration", "Polaris",
    ]);
    expect(TUTORIAL_CARDS.every((c) => c.body.length >= 2)).toBe(true);
  });

  test("Next leaves the current card and nothing else", () => {
    expect(markSeen("", "terminal")).toBe("terminal");
    expect(markSeen("terminal", "pull-requests")).toBe("terminal,pull-requests");
    // Clicking a card that was already read changes no order.
    expect(markSeen("pull-requests,terminal", "terminal")).toBe("terminal,pull-requests");
  });

  test("the fifth's Next is Done: there is no card after it", () => {
    expect(cardAfter("terminal")).toBe("pull-requests");
    expect(cardAfter("polaris")).toBeNull();
  });

  test("I have seen these before marks all five, in their order", () => {
    const all = markAllSeen();
    expect(all).toBe("terminal,pull-requests,tasks,agents,polaris");
    expect(cardsLeft(all)).toBe(0);
  });

  test("a stored list survives a reload, and an unknown id is ignored", () => {
    expect(seenCards("terminal,not-a-card,tasks")).toEqual(["terminal", "tasks"]);
    expect(cardsLeft("terminal,tasks")).toBe(3);
  });
});

describe("the offer", () => {
  test("counts the cards left and names them", () => {
    expect(tutorialOffer("")).toMatchObject({ left: 5, title: "Setup finished · 5 cards left" });
    expect(tutorialOffer("terminal,pull-requests,tasks")).toMatchObject({ left: 2, title: "Setup finished · 2 cards left" });
    expect(tutorialOffer("terminal,pull-requests,tasks,agents")).toMatchObject({ left: 1, title: "Setup finished · 1 card left" });
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
    const offer = src.slice(src.indexOf("export function SetupOffer"), src.indexOf("function TutorialArt"));
    expect(offer).not.toContain("saveSeen");
  });

  test("the dialog is a dialog, named", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-label="Tutorial"');
  });
});
