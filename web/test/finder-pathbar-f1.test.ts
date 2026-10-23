// The path bar's completion keys, the F1 sheet's zones and the preview's find keys, as Strata has them.
import { describe, expect, test } from "bun:test";
import { stepPick, tabComplete } from "../src/lib/finderMiller.ts";
import { finderKey, type Ctx, type KeyIn } from "../src/lib/finderKeys.ts";

const key = (k: string, o: Partial<KeyIn> = {}): KeyIn => ({ key: k, ctrl: false, meta: false, shift: false, alt: false, ...o });
const doc: Ctx = { inField: false, hasSelection: false, inPreview: true };
const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();

describe("Tab completion", () => {
  test("a moved selection wins, then a single candidate, then the shared prefix, then the selection cycles", () => {
    expect(tabComplete("d", ["docs", "dev"], 1, true)).toEqual({ fill: "dev/", hot: 1 });
    expect(tabComplete("d", ["docs"], 0, false)).toEqual({ fill: "docs/", hot: 0 });
    expect(tabComplete("re", ["report-a", "Report-b"], 0, false)).toEqual({ fill: "report-", hot: 0 });
    expect(tabComplete("report-", ["report-a", "report-b"], 0, false)).toEqual({ fill: null, hot: 1 });
    expect(tabComplete("report-", ["report-a", "report-b"], 1, false)).toEqual({ fill: null, hot: 0 });
    expect(tabComplete("x", [], 0, false)).toEqual({ fill: null, hot: 0 });
  });
  test("Page keys step five and stay inside the list", () => {
    expect(stepPick(0, 12, 5)).toBe(5);
    expect(stepPick(10, 12, 5)).toBe(11);
    expect(stepPick(2, 12, -5)).toBe(0);
    expect(stepPick(0, 0, 1)).toBe(0);
  });
});

describe("preview find keys", () => {
  test("Ctrl+F opens it; Enter and Esc are the bar's only while it is open", () => {
    expect(finderKey(key("f", { ctrl: true }), doc)).toEqual({ t: "pfind", do: "open" });
    expect(finderKey(key("Enter"), doc)?.t).not.toBe("pfind");
    const open = { ...doc, previewFind: true };
    expect(finderKey(key("Enter"), open)).toEqual({ t: "pfind", do: "next" });
    expect(finderKey(key("Enter", { shift: true }), open)).toEqual({ t: "pfind", do: "prev" });
    expect(finderKey(key("Escape"), open)).toEqual({ t: "pfind", do: "close" });
  });
});

describe("sources", () => {
  test("the path bar reports a failed path, copies for two seconds and completes with Tab", async () => {
    const bar = await src("components/finder/machine/FinderPathBar.tsx");
    expect(bar).toContain("setCopied(false), 2000");
    expect(bar).toContain('"Path copied"');
    expect(bar).toContain("tabComplete(");
    expect(bar).toContain("onFail?.(");
    expect(await src("components/finder/machine/MachineFinder.tsx")).toContain("onFail={setPathFailed}");
  });
  test("the F1 sheet has three zones with Ctrl+B / Ctrl+L and Home / End", async () => {
    const chrome = await src("components/finder/machine/FinderChrome.tsx");
    expect(chrome).toContain('low === "f" || low === "b" || low === "l"');
    expect(chrome).toContain('e.key === "Home" || e.key === "End"');
    expect(chrome).toContain('e.key === "Tab"');
  });
});
