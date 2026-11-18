/*
 * Settings ▸ Plugins draws its "Folder path or git URL" field by hand (the
 * mockup-v2 inset form), not through a row primitive, so the index once lost
 * it. The generator reads the block's `data-row={rowId(…)}`; this pins it.
 */
import { describe, expect, test } from "bun:test";
import { rowId, searchSettings } from "../src/lib/settingsIndex.ts";

describe("the add-plugin path field is findable", () => {
  test('"git url" finds it on the Plugins page and jumps to its block', () => {
    const hit = searchSettings("git url", [{ id: "plugins", label: "Plugins", kw: "" }]).find((r) => r.label === "Folder path or git URL");
    expect(hit?.pane).toBe("plugins");
    expect(hit?.row).toBe(rowId("Folder path or git URL"));
  });
});
