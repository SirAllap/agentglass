/*
 * The System / Dark / Light segment above the palette grid, and the two serious
 * neutral defaults it maps to — a faithful port of the palette Orca ships.
 */
import { describe, expect, test } from "bun:test";

// themes.ts → api.ts reads `location` at module scope; stub before importing.
(globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
const { THEMES, EXPERIMENTAL_THEME_IDS, resolveThemeMode, SERIOUS_DARK, SERIOUS_LIGHT } =
  await import("../src/lib/themes.ts");

const byId = (id: string) => THEMES.find((t) => t.id === id);
const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

describe("the serious neutral defaults", () => {
  test("Orca Dark and Orca Light exist with full palettes", () => {
    for (const id of ["orca-dark", "orca-light"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      for (const k of ["--bg", "--bg2", "--text", "--primary", "--border", "--error", "--success", "--warning", "--info"]) {
        expect(isHex(t!.vars[k]!), `${id} ${k} = ${t!.vars[k]}`).toBe(true);
      }
    }
  });

  test("one is genuinely dark, the other genuinely light", () => {
    expect(byId("orca-dark")!.vars["--bg"]).toBe("#0a0a0a");
    expect(byId("orca-light")!.vars["--bg"]).toBe("#ffffff");
  });
});

describe("the System / Dark / Light mode", () => {
  test("Dark and Light map to the serious pair", () => {
    expect(SERIOUS_DARK).toBe("orca-dark");
    expect(SERIOUS_LIGHT).toBe("orca-light");
    expect(resolveThemeMode("dark")).toBe("orca-dark");
    expect(resolveThemeMode("light")).toBe("orca-light");
  });

  test("Custom resolves to nothing — it defers to the grid pick", () => {
    expect(resolveThemeMode("custom")).toBeNull();
  });
});

describe("the old neutral pair", () => {
  test("Carbon and Paper are demoted to experimental, not removed", () => {
    expect(EXPERIMENTAL_THEME_IDS.has("carbon")).toBe(true);
    expect(EXPERIMENTAL_THEME_IDS.has("paper")).toBe(true);
    expect(byId("carbon"), "carbon still exists").toBeDefined();
    expect(byId("paper"), "paper still exists").toBeDefined();
  });
});
