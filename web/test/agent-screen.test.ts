import { describe, expect, test } from "bun:test";
import { agentScreenMode, paneBoxMode, offscreenSize, paneVisibility } from "../src/lib/agentScreen.ts";
import { classOf } from "../../shared/settingClass.ts";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

describe("agentScreenMode", () => {
  test("only a hidden pane with the setting on goes to the background", () => {
    expect(agentScreenMode(false, true)).toBe("background");
    expect(agentScreenMode(false, false)).toBe("raise");
    expect(agentScreenMode(true, true)).toBe("raise");
    expect(agentScreenMode(true, false)).toBe("raise");
  });
});

describe("paneBoxMode", () => {
  test("offscreen only for the hidden browser pane with the setting on", () => {
    expect(paneBoxMode(true, false, true)).toBe("offscreen");
    expect(paneBoxMode(true, false, false)).toBe("normal");
    expect(paneBoxMode(true, true, true)).toBe("normal");
    expect(paneBoxMode(false, false, true)).toBe("normal");
  });
  test("size is the last visible one, else 1280x800", () => {
    expect(offscreenSize({ w: 900, h: 600 })).toEqual({ w: 900, h: 600 });
    expect(offscreenSize(null)).toEqual({ w: 1280, h: 800 });
    expect(offscreenSize({ w: 0, h: 0 })).toEqual({ w: 1280, h: 800 });
  });
});

describe("browser.agentsWithoutScreen is registered", () => {
  test("it has a class and a row in the settings index", () => {
    expect(classOf("browser.agentsWithoutScreen")).toBeDefined();
    const r = SETTINGS_ROWS.find((x: { settingId?: string }) => x.settingId === "browser.agentsWithoutScreen");
    expect(r?.label).toBe("Let agents browse with the pane closed");
    expect(r?.hint).toBe("Their tabs load in the background; the pane does not open or take focus.");
  });
});

describe("paneVisibility", () => {
  test("a parked pane paints; an inactive stacked one is hidden", () => {
    expect(paneVisibility(false, true, false)).toBe("visible");
    expect(paneVisibility(false, false, false)).toBe("hidden");
    expect(paneVisibility(false, true, true)).toBe("hidden");
    expect(paneVisibility(true, false, false)).toBe("visible");
  });
});
