/*
 * The audio and video preview's decisions: the info line, the clock and
 * Strata's Ctrl+Alt chords, plus the wiring that keeps them scoped.
 *
 * What went wrong before: a bare native player with no length or codec and no
 * keys, so the preview could not be driven without the mouse.
 */
import { describe, expect, test } from "bun:test";
import { SEEK_SECONDS, applyMedia, clock, mediaAction, mediaLine, type Playable } from "../src/lib/finderMedia.ts";

const key = (key: string, o: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: true, altKey: true, ...o });
const player = (o: Partial<Playable> = {}): Playable & { played: number; paused_: number } => {
  const p = { paused: true, currentTime: 10, duration: 60, volume: 0.5, muted: false, played: 0, paused_: 0, play() { p.played++; p.paused = false; }, pause() { p.paused_++; p.paused = true; }, ...o };
  return p;
};

describe("clock", () => {
  test("minutes and seconds, hours from an hour, garbage is zero", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(192.9)).toBe("3:12");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(NaN)).toBe("0:00");
    expect(clock(-4)).toBe("0:00");
  });
});

describe("mediaLine", () => {
  test("a video with sound", () => {
    expect(mediaLine({ ok: true, duration: 192, bitRate: 800000, video: { codec: "h264", width: 1280, height: 720, fps: 29.97 }, audio: { codec: "aac", channels: 2 } }))
      .toBe("3:12 · H264 1280×720 · 30 fps · AAC stereo · 800 kbps");
  });
  test("audio alone, and nothing for a refusal", () => {
    expect(mediaLine({ ok: true, duration: 61, audio: { codec: "mp3", channels: 1 } })).toBe("1:01 · MP3 mono");
    expect(mediaLine({ ok: false, error: "x" })).toBe("");
    expect(mediaLine(null)).toBe("");
  });
});

describe("mediaAction", () => {
  test("Strata's chords, and only with Ctrl and Alt both down", () => {
    expect(mediaAction(key(" "))).toBe("toggle");
    expect(mediaAction(key("ArrowLeft"))).toBe("back");
    expect(mediaAction(key("ArrowRight"))).toBe("forward");
    expect(mediaAction(key("ArrowUp"))).toBe("louder");
    expect(mediaAction(key("ArrowDown"))).toBe("quieter");
    expect(mediaAction(key("m"))).toBe("mute");
    expect(mediaAction(key(" ", { altKey: false }))).toBeNull();
    expect(mediaAction(key(" ", { ctrlKey: false }))).toBeNull();
    expect(mediaAction(key(" ", { metaKey: true }))).toBeNull();
    expect(mediaAction(key("x"))).toBeNull();
  });
});

describe("applyMedia", () => {
  test("toggle plays a paused one and pauses a playing one", () => {
    const p = player();
    applyMedia(p, "toggle");
    expect(p.played).toBe(1);
    applyMedia(p, "toggle");
    expect(p.paused_).toBe(1);
  });
  test("seek moves five seconds and stays inside the file", () => {
    const p = player({ currentTime: 3 });
    applyMedia(p, "back");
    expect(p.currentTime).toBe(0);
    p.currentTime = 58;
    applyMedia(p, "forward");
    expect(p.currentTime).toBe(60);
    p.currentTime = 20;
    applyMedia(p, "forward");
    expect(p.currentTime).toBe(20 + SEEK_SECONDS);
  });
  test("a stream of unknown length still seeks forward", () => {
    const p = player({ duration: Infinity, currentTime: 7 });
    applyMedia(p, "forward");
    expect(p.currentTime).toBe(12);
  });
  test("volume steps by a tenth within 0 to 1, mute flips", () => {
    const p = player({ volume: 0.95 });
    applyMedia(p, "louder");
    expect(p.volume).toBe(1);
    p.volume = 0.05;
    applyMedia(p, "quieter");
    expect(p.volume).toBe(0);
    applyMedia(p, "mute");
    expect(p.muted).toBe(true);
  });
});

describe("wiring", () => {
  const read = (f: string) => Bun.file(new URL(f, import.meta.url)).text();
  test("the chords are caught on the preview's own wrapper, not on the window", async () => {
    const src = (await read("../src/components/finder/machine/MediaPreview.tsx")).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).toContain("onKeyDownCapture={onKeyDown}");
    expect(src).not.toContain("window.addEventListener");
    expect(src).not.toContain("document.addEventListener");
  });
  test("the probe runs when the preview opens, never from a hover", async () => {
    const hover = await read("../src/components/finder/machine/FolderPeek.tsx");
    expect(hover).not.toContain("previewMedia");
    expect(hover).not.toContain("frameUrl");
  });
  test("the body hands audio and video to MediaPreview", async () => {
    const src = await read("../src/components/finder/machine/PreviewBody.tsx");
    expect(src).toContain('case "audio": case "video": body = <MediaPreview');
  });
});

describe("placeholders", () => {
  test("Strata's words for loading, failing and nothing to draw", async () => {
    const { placeholderText } = await import("../src/lib/finderMedia.ts");
    expect(placeholderText("loading")).toEqual({ title: "Loading preview…", why: "" });
    expect(placeholderText("failed", "no permission to read this file")).toEqual({ title: "Preview unavailable", why: "no permission to read this file." });
    expect(placeholderText("failed", "gone.")).toEqual({ title: "Preview unavailable", why: "gone." });
    expect(placeholderText("binary")).toEqual({ title: "No visual preview", why: "Metadata is available for this file type." });
  });
  test("the panel uses them for the wait, the refusal and the binary", async () => {
    const quick = await Bun.file(new URL("../src/components/finder/machine/QuickLook.tsx", import.meta.url)).text();
    const body = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
    expect(quick).toContain('state={failed ? "failed" : "loading"}');
    expect(body).toContain('<Placeholder icon={bar.lead} state="binary"');
    expect(quick).not.toContain("Not shown: {failed}");
  });
});
