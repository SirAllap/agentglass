/*
 * Step 2: what a click writes.
 *
 * A mode click is a question about the window (System follows the desktop), so
 * it writes `appearance.mode`; a palette click is a choice of colours, so it
 * writes `appearance.theme`. The two are the Appearance page's own settings
 * (web/src/lib/settingsRegistry.ts), not a second pair invented here.
 */
import { describe, expect, test } from "bun:test";
import { modeTiles, paletteRows, themePick } from "../src/lib/setupTheme.ts";

describe("the three modes", () => {
  test("the current mode is the ringed one, and nothing else is", () => {
    expect(modeTiles("light").filter((m) => m.selected).map((m) => m.id)).toEqual(["light"]);
    expect(modeTiles("system").map((m) => m.state)).toEqual(["Matches desktop", "Always light", "Always dark"]);
  });

  test("a palette pick leaves no mode ringed, because the mode became custom", () => {
    expect(modeTiles("custom").every((m) => !m.selected)).toBe(true);
  });
});

describe("a click becomes one setting", () => {
  const have = { palettes: ["github-light", "graphite"], desk: false };

  test("System, Light and Dark write the mode", () => {
    expect(themePick("system", have)).toEqual({ setting: "appearance.mode", value: "system" });
    expect(themePick("light", have)).toEqual({ setting: "appearance.mode", value: "light" });
    expect(themePick("dark", have)).toEqual({ setting: "appearance.mode", value: "dark" });
  });

  test("a palette writes the theme", () => {
    expect(themePick("github-light", have)).toEqual({ setting: "appearance.theme", value: "github-light" });
  });

  test("a palette this build does not have, and a desktop palette that is not there, write nothing", () => {
    expect(themePick("nord", have)).toBeNull();
    expect(themePick("desktop", have)).toBeNull();
    expect(themePick("desktop", { ...have, desk: true })).toEqual({ setting: "appearance.theme", value: "desktop" });
  });
});

describe("the palette grid", () => {
  const themes = [
    { id: "github-light", name: "GitHub Light", preview: { primary: "#ffffff", secondary: "#f6f8fa", accent: "#0969da" } },
    { id: "graphite", name: "Graphite", preview: { primary: "#1e1e1e", secondary: "#262626", accent: "#e5e5e5" } },
    { id: "dracula", name: "Dracula", preview: { primary: "#282a36", secondary: "#343746", accent: "#bd93f9" } },
  ];

  test("the six the mock offers, in its order, and only those this build has", () => {
    expect(paletteRows(themes, "graphite", null).map((p) => p.id)).toEqual(["github-light", "graphite"]);
  });

  test("no desktop palette means no desktop row, never an empty one", () => {
    expect(paletteRows(themes, "graphite", null).some((p) => p.id === "desktop")).toBe(false);
  });

  test("the desktop palette is a row when the desktop publishes one, and the current one is marked", () => {
    const rows = paletteRows(themes, "desktop", { name: "Omarchy" });
    expect(rows.at(-1)).toMatchObject({ id: "desktop", name: "Omarchy", selected: true });
    expect(rows.filter((p) => p.selected)).toHaveLength(1);
  });
});
