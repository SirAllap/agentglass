/*
 * "Who reviews and checks" is a real setting, not a label the page keeps for
 * itself: the Flow editor's Reviewer controls bind their three controls to the server ids, and
 * the page reads and writes them through the settings door.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_WHO } from "../../shared/reviewSettings.ts";
import { CHECKS, DEFAULT_CHECKS, ROUND_MAX, ROUND_MIN, secondReviewerDefault } from "../src/components/orchestration/flow/flowCopy.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const PANE = read("components/orchestration/OrchestrationPane.tsx");
const CANVAS = read("components/orchestration/flow/ReviewerControls.tsx");
const SECTIONS = read("components/orchestration/flow/FlowSections.tsx");

describe("the Reviewer block is bound to the three settings", () => {
  test("one row per setting, with its server id", () => {
    for (const id of ["orchestration.review.who", "orchestration.review.rounds", "orchestration.review.second"]) {
      expect(CANVAS + read("components/orchestration/flow/FlowEditor.tsx")).toContain(`REVIEW_SETTING_IDS.${id.split(".").pop()}`);
    }
  });

  test("the answers are the server's, in its order", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([...REVIEW_WHO]);
    expect(DEFAULT_CHECKS).toBe("second");
  });

  test("the round cap is the server's range", () => {
    expect([ROUND_MIN, ROUND_MAX]).toEqual([1, 6]);
  });

  test("the round stepper stops while the page is busy", () => {
    expect(CANVAS).toContain("disabled={busy || rounds <= REVIEW_ROUNDS_MIN}");
    expect(CANVAS).toContain("disabled={busy || rounds >= REVIEW_ROUNDS_MAX}");
  });
});

describe("the canvas panel is bound to the same settings", () => {
  test("ReviewerControls reads and writes the ids through the door", () => {
    expect(CANVAS).toContain("REVIEW_SETTING_IDS.who");
    expect(CANVAS).toContain("REVIEW_SETTING_IDS.second");
    expect(CANVAS).toContain("api.settingAtSet(id, value, p.root)");
  });
});

describe("the page reads the round cap; the Flow editor writes the three", () => {
  test("the page reads only the round cap, for the sentence under Safety and limits", () => {
    expect(PANE).toContain("REVIEW_SETTING_IDS.rounds");
    expect(PANE).toContain("api.settingAt(REVIEW_SETTING_IDS.rounds, root)");
    expect(PANE).not.toContain("REVIEW_SETTING_IDS.who");
  });

  test("the page no longer writes a review setting: the door writes here are the person's presets", () => {
    expect(PANE).not.toContain("settingAtSet(REVIEW_SETTING_IDS");
    expect(PANE).toContain('api.settingAtSet("orchestration.presets"');
  });

  test("nothing says the setting is not built", () => {
    expect(CANVAS).not.toContain("LATER_SLICE");
    expect(SECTIONS).not.toContain("LATER_SLICE");
  });

  test("the engine pick keeps the not-ready option, shown and not offered", () => {
    expect(CANVAS).toContain("disabled: o.disabled");
    expect(CANVAS).toContain("title: o.hint");
  });
});

describe("a second reviewer is a second engine", () => {
  const opts = [{ value: "claude" }, { value: "opencode" }, { value: "codex", disabled: true }];

  test("turning it on starts on an engine the first Reviewer is not on", () => {
    expect(secondReviewerDefault({ engine: "claude" }, opts)).toEqual({ engine: "opencode", model: "" });
    expect(secondReviewerDefault({ engine: "opencode" }, opts)).toEqual({ engine: "claude", model: "" });
    expect(secondReviewerDefault(null, opts)).toEqual({ engine: "claude", model: "" });
  });

  test("with no other engine ready it stays off instead of copying the first", () => {
    expect(secondReviewerDefault({ engine: "claude" }, [{ value: "claude" }])).toBeNull();
    expect(secondReviewerDefault({ engine: "claude" }, [{ value: "claude" }, { value: "opencode", disabled: true }])).toBeNull();
  });

  test("the Reviewer controls use it, and no longer fall back to the first Reviewer's own engine", () => {
    expect(CANVAS).toContain("secondReviewerDefault(first, engineOptions");
    expect(CANVAS).not.toContain('?? "claude"');
  });
});
