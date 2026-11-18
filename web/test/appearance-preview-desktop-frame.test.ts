/* Window & startup and Appearance draw their window inside the one DesktopFrame; neither spells the desktop itself. */
import { describe, expect, it } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/components/settings/previews/${p}`, import.meta.url)).text();
const frame = await read("DesktopFrame.tsx");
const win = await read("WindowPreview.tsx");
const look = await read("AppearancePreview.tsx");

describe("settings previews share one desktop frame", () => {
  it("both wrap LiveWindow in DesktopFrame", () => {
    for (const src of [win, look]) {
      expect(src).toContain('import { DesktopFrame } from "./DesktopFrame.tsx";');
      expect(src).toMatch(/<DesktopFrame [^>]*>\s*<LiveWindow/);
    }
  });
  it("Appearance passes its theme and nothing of its own around the window", () => {
    expect(look).toContain("<DesktopFrame preview=\"appearance\" vars={previewVars(p.theme, p.accent)}>");
    expect(look).not.toContain("linear-gradient");
    expect(look).not.toContain("data-frame");
  });
  it("only the frame draws the top bar, the dots and the surround", () => {
    for (const src of [win, look]) {
      expect(src).not.toContain("Tue 23 Oct");
      expect(src).not.toContain("data-frame");
      expect(src).not.toContain("linear-gradient");
    }
    expect(frame).toContain("Tue 23 Oct");
    expect(frame).toContain("data-frame");
    expect(frame).toContain('<span className="flex-1 text-center">agentglass</span>');
  });
});
