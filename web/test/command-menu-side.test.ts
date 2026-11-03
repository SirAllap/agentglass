/*
 * The Commands menu hangs from whichever edge of its button keeps it on screen.
 *
 * It was always hung from the button's left edge at a fixed 460px, and the
 * button sits at the right end of the terminal's strip: on a narrower window
 * the menu, filter box included, ran past the window's right side.
 */
import { describe, expect, it } from "bun:test";
import { menuSide } from "../src/components/CommandBar.tsx";

describe("the Commands menu stays on screen", () => {
  it("hangs from the left edge when it fits", () => {
    expect(menuSide(100, 200, 1600)).toBe("left");
  });

  it("flips to the right edge near the window's right side", () => {
    // A button at 1400-1480 in a 1600px window: 1400 + 460 overflows.
    expect(menuSide(1400, 1480, 1600)).toBe("right");
  });

  it("keeps the left edge when neither fits, rather than running off the left", () => {
    expect(menuSide(10, 60, 300)).toBe("left");
  });
});

describe("the terminal has no dot on the rail", () => {
  it("is not given one, and the rail draws a dot only for a pip that asks", async () => {
    // The rail draws no dot of its own: a view that wants one asks for it, as the
    // Manifest does for rows waiting on a verdict. The terminal's pip has none.
    const ws = await Bun.file(new URL("../src/components/workspace/Workspace.tsx", import.meta.url)).text();
    const rail = await Bun.file(new URL("../src/components/workspace/ViewRail.tsx", import.meta.url)).text();
    expect(ws).not.toMatch(/\bterm:\s*\{[^}]*dot/);
    expect(rail).toContain("pip?.dot");
  });
});
