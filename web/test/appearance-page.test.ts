import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { APPEARANCE_SECTIONS } from "../src/components/settings/pages/appearanceModel.ts";
import { hasRail, orderSections } from "../src/components/settings/shell/shellRules.ts";

const stubGlobal = globalStubs();
stubGlobal("window", new EventTarget());
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
const { SETTING_DEFS } = await import("../src/lib/settingsRegistry.ts");

const rows = APPEARANCE_SECTIONS.flatMap((s) => s.rows);

describe("Appearance page model", () => {
  test("every row has help of one sentence, 14 words at most, ending in a full stop", () => {
    for (const r of rows) {
      expect(r.help.endsWith(".")).toBe(true);
      expect(r.help.split(/\s+/).length).toBeLessThanOrEqual(14);
      expect(r.label.endsWith(".")).toBe(false);
    }
  });
  test("each row label appears once", () => {
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  test("every registry id of the old appearance, prefs and rail pages is placed once", () => {
    const placed = rows.filter((r) => r.id).map((r) => r.id!);
    for (const id of placed.filter((i) => !i.endsWith("*"))) expect(SETTING_DEFS.some((d) => d.id === id)).toBe(true);
    const old = SETTING_DEFS.filter((d) => d.page === "appearance").map((d) => d.id);
    for (const id of old) expect(placed.filter((p) => p === id).length).toBe(1);
    expect(SETTING_DEFS.some((d) => d.id.startsWith("rail.place."))).toBe(true);
    expect(placed.filter((p) => p === "rail.place.*").length).toBe(2);
    expect(placed.filter((p) => p === "rail.badge.*").length).toBe(1);
  });
  test("four sections: rail (2+ sections), no danger zone, order kept", () => {
    expect(hasRail(APPEARANCE_SECTIONS.length)).toBe(true);
    expect(orderSections(APPEARANCE_SECTIONS).map((s) => s.id)).toEqual(["look", "theme", "window", "sidebar"]);
    expect(APPEARANCE_SECTIONS.some((s) => s.kind === "danger")).toBe(false);
  });
});
