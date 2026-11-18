import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { furnitureFloor } from "../src/lib/furnitureFloor.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
const panel = { top: 80, bottom: 880, left: 1100, right: 1580 };

describe("the detail panel keeps its bottom clear of the floating bench button", () => {
  test("a button over the panel's lower corner reserves from its top edge plus the gap", () => {
    expect(furnitureFloor(panel, [{ top: 836, bottom: 874, left: 1517, right: 1555 }])).toBe(880 - 836 + 8);
  });
  test("a button beside the panel, or high in it, reserves nothing", () => {
    expect(furnitureFloor(panel, [{ top: 836, bottom: 874, left: 900, right: 938 }])).toBe(0);
    expect(furnitureFloor(panel, [{ top: 100, bottom: 138, left: 1517, right: 1555 }])).toBe(0);
    expect(furnitureFloor(panel, [])).toBe(0);
  });
  test("the dock applies the floor to its content, re-measured when the card, mode or float box changes", () => {
    const dock = src("components/jira/list/JiraDock.tsx");
    expect(dock).toContain("useFurnitureFloor<HTMLDivElement>([card?.id, mode, maximized, at.x, at.y, size.w, size.h])");
    expect(dock).toContain("marginBottom: floor");
    expect(src("lib/furnitureFloor.ts")).toContain('"[data-floating-furniture]"');
  });
});

describe("the board name stays whole after a folder breadcrumb", () => {
  test("folder parts shrink first; the board name shrinks last", () => {
    const bar = src("components/jira/list/JiraToolbar.tsx");
    expect(bar).toContain('flex: last ? "0 1 auto" : "0 1000 auto"');
    expect(bar).not.toContain('"0 1 120px"');
  });
});

describe("the board footer keeps its right end clear of the bench button", () => {
  test("the footer pads its right side by the measured clearance", () => {
    const foot = src("components/jira/list/JiraFooter.tsx");
    expect(foot).toContain("useFurnitureClear<HTMLDivElement>([title ?? model.view?.name, !!note])");
    expect(foot).toContain("padding: `0 ${24 + clear}px 0 24px`");
  });
});
