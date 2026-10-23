/*
 * Strata's "Render documents by default": a Markdown or HTML file opens on its
 * rendered view when it is on (the default) and on its source when it is off.
 * A file that has no rendered view, and a view the person already picked for
 * this file, are not its business.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, readPrefs } from "../src/lib/finderMiller.ts";
import { defaultTab, previewPlan } from "../src/lib/finderPreview.ts";
import { ROWS } from "../src/lib/finderSettingsModel.ts";

const plan = (name: string) => previewPlan({ name, kind: "text", bytes: 10 });

describe("which view a document opens on", () => {
  test("on: Markdown and HTML open rendered, whatever order the plan lists them in", () => {
    expect(defaultTab(plan("a.md").tabs, true)).toBe("Rendered");
    expect(defaultTab(plan("a.html").tabs, true)).toBe("Rendered");
  });
  test("off: both open on their source", () => {
    expect(defaultTab(plan("a.md").tabs, false)).toBe("Source");
    expect(defaultTab(plan("a.html").tabs, false)).toBe("Source");
  });
  test("a file with no rendered view keeps its own first view", () => {
    expect(defaultTab(plan("a.py").tabs, false)).toBe("Reading");
    expect(defaultTab(plan("a.json").tabs, true)).toBe("Reading");
    expect(defaultTab([], true)).toBe("Reading");
  });
});

describe("the setting", () => {
  test("on by default, as in Strata", () => expect(DEFAULT_PREFS.renderDocs).toBe(true));
  test("a wrong stored type falls back alone", () => {
    expect(readPrefs(JSON.stringify({ renderDocs: false })).renderDocs).toBe(false);
    expect(readPrefs(JSON.stringify({ renderDocs: "no", autoplay: true })).renderDocs).toBe(true);
  });
  test("it has Strata's row, after Autoplay", () => {
    const ids = ROWS.filter((r) => r.section === "Browsing").map((r) => r.id);
    expect(ids.indexOf("renderDocs")).toBe(ids.indexOf("autoplay") + 1);
    expect(ROWS.find((r) => r.id === "renderDocs")).toMatchObject({ title: "Render documents by default", desc: "Open Markdown and HTML previews in the rendered view instead of source." });
  });
});

describe("the preview asks it", () => {
  test("the first tab comes from defaultTab and follows the setting", async () => {
    const s = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
    expect(s).toContain("defaultTab(plan.tabs, renderDocs)");
    expect(s).not.toContain("plan.tabs[0] ??");
  });
});
