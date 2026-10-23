/*
 * The audio and video preview's info line and poster frame.
 *
 * What went wrong before: the panel showed a bare player with no length, codec
 * or size of picture, and a video gave no hint of what it held until it was
 * played. Pinned here: ffprobe's answer reduced to the few fields the line
 * shows, a cover picture is not a video, and the same boundary as the list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaFacts, parseProbe, posterFrame } from "../src/mediafacts.ts";

const d = mkdtempSync(join(tmpdir(), "agx-media-"));
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
process.env.AGENTGLASS_DISK_ROOTS = d;
afterAll(() => {
  rmSync(d, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS;
  else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});

const haveFfmpeg = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");

describe("parseProbe", () => {
  test("a video with sound", () => {
    const f = parseProbe({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
      ],
      format: { duration: "3.0", bit_rate: "800000" },
    });
    expect(f).toEqual({
      ok: true, duration: 3, bitRate: 800000,
      video: { codec: "h264", width: 1280, height: 720, fps: 29.97 },
      audio: { codec: "aac", channels: 2, sampleRate: 48000 },
    });
  });

  test("a cover picture inside an mp3 is not a video", () => {
    const f = parseProbe({
      streams: [
        { codec_type: "audio", codec_name: "mp3", channels: 2 },
        { codec_type: "video", codec_name: "mjpeg", width: 500, height: 500, disposition: { attached_pic: 1 } },
      ],
      format: { duration: "61.5", tags: { TITLE: "Harbour", ARTIST: "Orbit Trio", track: "3/9" } },
    });
    expect(f.video).toBeUndefined();
    expect(f.title).toBe("Harbour");
    expect(f.artist).toBe("Orbit Trio");
    expect(f.track).toBe("3/9");
  });

  test("nothing playable is a refusal that says so", () => {
    expect(parseProbe({ streams: [{ codec_type: "subtitle" }] })).toEqual({ ok: false, error: "no audio or video stream" });
    expect(parseProbe(null).ok).toBe(false);
  });
});

describe("mediaFacts and posterFrame", () => {
  test("a path outside the places the list shows is refused before any tool runs", async () => {
    expect((await mediaFacts("/etc/passwd")).ok).toBe(false);
    expect((await posterFrame("/etc/passwd")).ok).toBe(false);
  });

  test("a text file renamed .mp4 is not media", async () => {
    writeFileSync(join(d, "fake.mp4"), "not a video");
    const r = await mediaFacts(join(d, "fake.mp4"));
    expect(r.ok).toBe(false);
    expect((await posterFrame(join(d, "fake.mp4"))).ok).toBe(false);
  });

  test.skipIf(!haveFfmpeg)("a real 2 s clip reports its length and gives a jpeg frame", async () => {
    const p = join(d, "clip.mp4");
    const mk = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-pix_fmt", "yuv420p", p]);
    expect(mk.exitCode).toBe(0);
    const f = await mediaFacts(p);
    expect(f.ok).toBe(true);
    expect(f.duration).toBeGreaterThan(1.5);
    expect(f.video?.width).toBe(320);
    expect(f.audio).toBeDefined();
    const poster = await posterFrame(p);
    if (!poster.ok) throw new Error(poster.error);
    expect(poster.body[0]).toBe(0xff);
    expect(poster.body[1]).toBe(0xd8);
  }, 20000);
});
