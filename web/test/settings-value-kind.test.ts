import { test, expect } from "bun:test";
import { valueKind, flagsTable, splitTouch, keyCount, enumLabel } from "../src/components/settings/pages/valueKind.ts";

test("valueKind picks a kind by type", () => {
  expect(valueKind(false)).toBe("boolean");
  expect(valueKind("bypassPermissions")).toBe("enum");
  expect(enumLabel("bypassPermissions")).toBe("Bypass");
  expect(valueKind(["Bash(a)", "Bash(b)"])).toBe("list");
  expect(valueKind({ a: 1 })).toBe("object");
  expect(valueKind([{ a: 1 }])).toBe("object");
  for (const e of [undefined, null, "", [], {}]) expect(valueKind(e)).toBe("empty");
  expect(valueKind("x".repeat(81))).toBe("long");
  expect(valueKind("short")).toBe("text");
  expect(valueKind(30)).toBe("text");
});

test("keyCount reads in plain words", () => {
  expect(keyCount({ a: 1, b: 2 })).toBe("2 keys");
  expect(keyCount({ a: 1 })).toBe("1 key");
});

test("flagsTable: engines down, four modes across, no flags is an empty cell", () => {
  const t = flagsTable([{ engine: "Codex", value: { default: ["--ask"], bypassPermissions: "--yolo --x" } }, { engine: "Qwen Code", value: undefined }]);
  expect(t.modes.map((m) => m.label)).toEqual(["Ask", "Auto", "Accept edits", "Bypass"]);
  expect(t.rows[0]!.cells).toEqual([["--ask"], [], [], ["--yolo", "--x"]]);
  expect(t.rows[1]!.cells).toEqual([[], [], [], []]);
});

test("splitTouch separates what it does from when to touch it", () => {
  expect(splitTouch("Isolate terminals. Only to debug a hang.")).toEqual({ what: "Isolate terminals.", when: "To debug a hang" });
  expect(splitTouch("Only if planner runs fail on write.")).toEqual({ what: "Only if planner runs fail on write.", when: null });
  expect(splitTouch("Let a worker touch .git. Only if it must rewrite history.")).toEqual({ what: "Let a worker touch .git.", when: "If it must rewrite history" });
  expect(splitTouch("Check-ins feel too frequent.")).toEqual({ what: "Check-ins feel too frequent.", when: null });
});
