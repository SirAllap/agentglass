/*
 * Typed edits, before they become a write.
 *
 * The case worth pinning is the empty box. "Clear this" and "leave this alone"
 * are different edits and they look identical from a text input — get it wrong
 * one way and a due date can never be removed, the other way and opening a
 * field wipes it.
 */
import { describe, expect, test } from "bun:test";
import { dayToMs, describeWithComment, estimateText, msToDay, parseEstimate, parsePoints, sortSprints, sprintShort } from "../src/lib/cardEdits.ts";

describe("points", () => {
  test("a number is that number, and halves survive", () => {
    expect(parsePoints("3")).toEqual({ ok: true, value: 3 });
    expect(parsePoints(" 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(parsePoints("0")).toEqual({ ok: true, value: 0 });
  });

  test("an empty box clears them rather than meaning nothing", () => {
    expect(parsePoints("")).toEqual({ ok: true, value: null });
    expect(parsePoints("   ")).toEqual({ ok: true, value: null });
  });

  test("words and negatives are refused here, with a reason", () => {
    expect(parsePoints("lots").ok).toBe(false);
    expect(parsePoints("-2").error).toContain("negative");
  });
});

describe("estimate", () => {
  test("the ways people write one", () => {
    expect(parseEstimate("4h").value).toBe(4 * 3_600_000);
    expect(parseEstimate("30m").value).toBe(30 * 60_000);
    expect(parseEstimate("1h 30m").value).toBe(90 * 60_000);
    expect(parseEstimate("2.5h").value).toBe(9_000_000);
    // A bare number is hours, which is what somebody typing "4" means.
    expect(parseEstimate("4").value).toBe(4 * 3_600_000);
  });

  test("empty clears it", () => {
    expect(parseEstimate("")).toEqual({ ok: true, value: null });
  });

  /* Silently ignoring the rest of the line is how "4h and a bit" becomes four
     hours and nobody notices the bit. */
  test("something it does not understand is refused, not half-read", () => {
    expect(parseEstimate("4h and a bit").ok).toBe(false);
    expect(parseEstimate("soon").ok).toBe(false);
  });

  test("and back again, for the box to open with", () => {
    expect(estimateText(90 * 60_000)).toBe("1h 30m");
    expect(estimateText(4 * 3_600_000)).toBe("4h");
    expect(estimateText(45 * 60_000)).toBe("45m");
    expect(estimateText(null)).toBe("");
    expect(parseEstimate(estimateText(5_400_000)).value).toBe(5_400_000);
  });
});

describe("dates", () => {
  /* Midnight local is the previous day for anybody east of here, so a due date
     would move depending on who read the card. */
  test("a day is recorded at noon, and comes back as the same day", () => {
    const ms = dayToMs("2026-08-21")!;
    expect(new Date(ms).getHours()).toBe(12);
    expect(msToDay(ms)).toBe("2026-08-21");
  });

  test("an empty box is a clear, both ways", () => {
    expect(dayToMs("")).toBeNull();
    expect(msToDay(null)).toBe("");
  });
});

describe("sprints", () => {
  test("the number is what people say, the dates are noise once chosen", () => {
    expect(sprintShort("Sprint 42 (26/8/19 - 26/8/25)")).toBe("Sprint 42");
    // A list that is not a sprint keeps its whole name.
    expect(sprintShort("Bugs")).toBe("Bugs");
  });

  test("newest first: the sprint being planned is the one being picked", () => {
    const lists = [{ name: "Sprint 9 (a)" }, { name: "Sprint 41 (b)" }, { name: "Sprint 40 (c)" }];
    expect(sortSprints(lists).map((l) => sprintShort(l.name))).toEqual(["Sprint 41", "Sprint 40", "Sprint 9"]);
  });
});

describe("a comment folded into the description", () => {
  test("says whose writing it is, because the two documents are not the same person's", () => {
    const out = describeWithComment("What the reporter wrote.", {
      text: "The search is answering with the wrong thirty rows.",
      who: "Ada Lovelace",
      at: 1_700_000_000_000,
    }, () => "6 Apr");
    expect(out).toContain("What the reporter wrote.");
    expect(out).toContain("**From a comment by Ada Lovelace · 6 Apr**");
    expect(out).toContain("The search is answering with the wrong thirty rows.");
    // A rule between them: these are two documents, not one paragraph.
    expect(out).toContain("\n---\n");
  });

  test("starts with the comment when the description is empty", () => {
    // A rule that separates the comment from nothing is a rule that reads as a
    // missing paragraph.
    const out = describeWithComment("", { text: "Only this.", who: "Ana" }, () => "");
    expect(out.startsWith("**From a comment by Ana**")).toBe(true);
    expect(out).not.toContain("---");
  });

  test("leaves the description alone when there is nothing to add", () => {
    expect(describeWithComment("Keep me.", { text: "   \n  ", who: "Ana" })).toBe("Keep me.");
  });

  test("names somebody even when the comment does not", () => {
    expect(describeWithComment("", { text: "x", who: "  " }, () => "")).toContain("by someone");
  });

  test("does not run two documents together", () => {
    const out = describeWithComment("Ends here.", { text: "Starts here.", who: "Ana" }, () => "");
    expect(out).not.toContain("Ends here.---");
    expect(out.split("\n---\n")).toHaveLength(2);
  });
});
