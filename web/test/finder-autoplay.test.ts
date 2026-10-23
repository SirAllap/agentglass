/*
 * Strata's "Autoplay media previews": video, audio and GIF previews start by
 * themselves only when it is on (it is off by default). A GIF is a picture the
 * browser animates on its own, so "off" has to hold it on its first frame.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, readPrefs } from "../src/lib/finderMiller.ts";
import { isGif } from "../src/lib/finderPreview.ts";
import { ROWS } from "../src/lib/finderSettingsModel.ts";

describe("the setting", () => {
  test("off by default, as in Strata", () => expect(DEFAULT_PREFS.autoplay).toBe(false));
  test("a wrong stored type falls back alone", () => {
    expect(readPrefs(JSON.stringify({ autoplay: true })).autoplay).toBe(true);
    expect(readPrefs(JSON.stringify({ autoplay: 1, peek: true })).autoplay).toBe(false);
  });
  test("it has Strata's row, right after Single-click file previews", () => {
    const ids = ROWS.filter((r) => r.section === "Browsing").map((r) => r.id);
    expect(ids.indexOf("autoplay")).toBe(ids.indexOf("preview") + 1);
    expect(ROWS.find((r) => r.id === "autoplay")).toMatchObject({ title: "Autoplay media previews", desc: "Start playing video, audio, and GIF previews as soon as they open." });
  });
});

describe("what counts as a GIF", () => {
  test("by extension, any case", () => { expect(isGif("loop.GIF")).toBe(true); expect(isGif("a.gif.png")).toBe(false); expect(isGif("gif")).toBe(false); });
});

describe("the preview draws it", () => {
  const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
  test("audio and video take autoPlay from the setting, never a literal", async () => {
    const s = await read("PreviewBody.tsx");
    expect(s.match(/autoPlay=\{autoplay\}/g)?.length).toBe(2);
    expect(s).not.toMatch(/autoPlay(?!=\{autoplay\})/);
  });
  test("a GIF is held still unless autoplay is on or the person asks to play it", async () => {
    const s = await read("PreviewBody.tsx");
    expect(s).toContain("isGif(facts.name) && !autoplay");
    expect(s).toContain("StillGif");
  });
});
