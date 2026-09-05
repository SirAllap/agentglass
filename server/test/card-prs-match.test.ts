/*
 * Which pull requests really belong to a card.
 *
 * Measured on his own repository, on card ORBIT-1042. GitHub's search answered
 * with three, and all three were wrong:
 *
 *   #1042  matched by its own NUMBER — no "1042" anywhere in its title or
 *           body, and its branch is ORBIT-2318-…
 *   #1436  its body mentions "PR #1042 (ORBIT-2318, inline FAQ default)".
 *   #1188  its body lists in-flight pull requests: (#667, …, #1042).
 *
 * The search stays — the id can be in a branch, a title or a body, and which of
 * those is not ours to assume — but every row it returns is checked.
 */
import { describe, expect, test } from "bun:test";
import { mentionsCard } from "../src/clickup.ts";

const ID = "ORBIT-1042";

describe("a pull request that names the card", () => {
  test("in its branch, its title or its body", () => {
    expect(mentionsCard(ID, { headRefName: "ORBIT-1042-caller-number-not-found" })).toBe(true);
    expect(mentionsCard(ID, { title: "ORBIT-1042 — caller number not found" })).toBe(true);
    expect(mentionsCard(ID, { body: "Fixes ORBIT-1042." })).toBe(true);
  });

  test("however it was typed", () => {
    expect(mentionsCard(ID, { body: "closes orbit-1042" })).toBe(true);
  });
});

describe("and the three that did not", () => {
  test("the one whose NUMBER happens to be the card's digits", () => {
    expect(mentionsCard(ID, {
      headRefName: "ORBIT-2318-Enable-inline-answers-by-default",
      title: "Enable inline answers on by default",
      body: "Nothing about that card at all.",
    })).toBe(false);
  });

  test("the one that mentions ANOTHER pull request by that number", () => {
    expect(mentionsCard(ID, {
      title: "Hotfix — latency, round 3",
      body: "> PR #1042 (ORBIT-2318, inline FAQ default) was previously merged into this branch.",
    })).toBe(false);
  });

  test("the one that lists in-flight pull requests", () => {
    expect(mentionsCard(ID, {
      title: "Perceived latency analysis and brief",
      body: "- Audit of in-flight open PRs (#1030, #1031, #1033, #1037, #1039, #1040, #1042)",
    })).toBe(false);
  });
});

describe("the boundary", () => {
  test("a shorter id does not match a longer one, and the other way round", () => {
    expect(mentionsCard("ORBIT-104", { body: "ORBIT-1042" })).toBe(false);
    expect(mentionsCard("ORBIT-1042", { body: "ORBIT-10420" })).toBe(false);
  });

  test("but ordinary punctuation around it still counts", () => {
    expect(mentionsCard(ID, { body: "(ORBIT-1042)" })).toBe(true);
    expect(mentionsCard(ID, { body: "ORBIT-1042: the fix" })).toBe(true);
    expect(mentionsCard(ID, { body: "see ORBIT-1042." })).toBe(true);
  });

  test("no card, no match", () => {
    expect(mentionsCard("", { body: "anything" })).toBe(false);
  });
});
