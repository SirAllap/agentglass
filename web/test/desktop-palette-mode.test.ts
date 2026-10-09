// A palette Omarchy derives from a theme has no `mode` line; it is light or dark by its background.
import { describe, expect, test } from "bun:test";
import { desktopTheme } from "../../shared/desktopPalette.ts";

describe("a palette without a mode line", () => {
  const light = { background: "#fdf6e3", foreground: "#586e75" };
  const dark = { background: "#1a1b26", foreground: "#c0caf5" };
  test("is light or dark by its background", () => {
    expect(desktopTheme(light, "x")!.dark).toBe(false);
    expect(desktopTheme(dark, "x")!.dark).toBe(true);
  });
  test("a stated mode still wins", () => {
    expect(desktopTheme({ ...light, mode: "dark" }, "x")!.dark).toBe(true);
    expect(desktopTheme({ ...dark, mode: "light" }, "x")!.dark).toBe(false);
  });
});
