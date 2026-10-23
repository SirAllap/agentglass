/*
 * The bytes of a file for the Machine tab's viewers: a slice, never a read of
 * the whole thing.
 *
 * What went wrong before: the raw route read every file whole into memory and
 * served it as one body, so a 50 MB log cost 50 MB per click, a video could not
 * seek, and an audio file went out as `audio/*`, which is not a media type.
 * Pinned here: the same boundary as the folder list, a byte cap, correct types,
 * and Range for the players.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CAP, previewSlice, parseRange } from "../src/browse.ts";

const made: string[] = [];
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-slice-"));
  made.push(d);
  process.env.AGENTGLASS_DISK_ROOTS = made.join(":");
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS;
  else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});

const text = async (r: Awaited<ReturnType<typeof previewSlice>>) => {
  if (!r.ok) throw new Error(r.error);
  return await new Response(r.body).text();
};

describe("parseRange", () => {
  test("a closed, an open and a suffix range", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  });
  test("an end past the file is clamped, a start past it is unsatisfiable", () => {
    expect(parseRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
  });
  test("nothing that is not one plain byte range is believed", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=a-b", 10)).toBeNull();
  });
});

describe("previewSlice", () => {
  test("the whole of a small file, with its size and a media type", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.json"), '{"a":1}');
    const r = await previewSlice(join(d, "a.json"), false, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.size).toBe(7);
    expect(r.headers["content-length"]).toBe("7");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(await text(r)).toBe('{"a":1}');
  });

  test("a byte cap serves the head and says it cut", async () => {
    const d = tmp();
    writeFileSync(join(d, "big.log"), "0123456789".repeat(100));
    const r = await previewSlice(join(d, "big.log"), false, { cap: 25 });
    if (!r.ok) throw new Error(r.error);
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("0123456789012345678901234");
    expect(r.headers["x-agx-size"]).toBe("1000");
    expect(r.headers["x-agx-truncated"]).toBe("1");
  });

  test("a Range gets 206, the right bytes and a content-range", async () => {
    const d = tmp();
    writeFileSync(join(d, "n.txt"), "abcdefghij");
    const r = await previewSlice(join(d, "n.txt"), false, { range: "bytes=2-4" });
    if (!r.ok) throw new Error(r.error);
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe("bytes 2-4/10");
    expect(r.headers["content-length"]).toBe("3");
    expect(await text(r)).toBe("cde");
  });

  test("a Range past the end is 416, not an empty 200", async () => {
    const d = tmp();
    writeFileSync(join(d, "n.txt"), "abc");
    const r = await previewSlice(join(d, "n.txt"), false, { range: "bytes=9-" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(416);
    expect(r.headers?.["content-range"]).toBe("bytes */3");
  });

  test("audio and video go out with real media types, never audio/*", async () => {
    const d = tmp();
    for (const [name, mime] of [["a.mp3", "audio/mpeg"], ["a.wav", "audio/wav"], ["a.ogg", "audio/ogg"], ["a.m4a", "audio/mp4"], ["v.mkv", "video/x-matroska"], ["v.mov", "video/quicktime"], ["v.mp4", "video/mp4"]] as const) {
      writeFileSync(join(d, name), "x");
      const r = await previewSlice(join(d, name), false, {});
      if (!r.ok) throw new Error(`${name}: ${r.error}`);
      expect(r.mime).toBe(mime);
    }
  });

  test("past the hard cap, with no Range and no cap, it refuses and says why", async () => {
    const d = tmp();
    const p = join(d, "huge.bin");
    writeFileSync(p, "");
    // A sparse file: the size is real, the disk is not spent.
    const fs = await import("node:fs");
    fs.truncateSync(p, FILE_CAP + 1);
    const r = await previewSlice(p, false, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(413);
    expect(r.error).toMatch(/64 MB/);
    // The same file is playable by ranges.
    const part = await previewSlice(p, false, { range: "bytes=0-9" });
    expect(part.ok).toBe(true);
  });

  test("a folder and a missing file are refused", async () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    expect((await previewSlice(join(d, "sub"), false, {})).ok).toBe(false);
    expect((await previewSlice(join(d, "nope.txt"), false, {})).ok).toBe(false);
  });

  test("a fifo is refused, not opened: opening one blocks forever", async () => {
    // In a child with a deadline, because the failure this pins is a hang, and a
    // hang in this process would take the whole suite with it.
    const d = tmp();
    const fifo = join(d, "pipe");
    Bun.spawnSync(["mkfifo", fifo]);
    const code = `import { previewSlice } from ${JSON.stringify(new URL("../src/browse.ts", import.meta.url).pathname)};
      const r = await previewSlice(${JSON.stringify(fifo)}, false, {}); console.log(r.ok ? "served" : "refused");`;
    const p = Bun.spawn(["bun", "-e", code], { env: { ...process.env, AGENTGLASS_DISK_ROOTS: d }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(9), 4000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    expect(out.trim()).toBe("refused");
  });

  test("the folder boundary holds: outside the roots, and a link out of them", async () => {
    const d = tmp();
    const out = mkdtempSync(join(tmpdir(), "agx-slice-out-"));
    made.push(out);
    process.env.AGENTGLASS_DISK_ROOTS = d; // only d is a root now
    writeFileSync(join(out, "secret.txt"), "nope");
    expect((await previewSlice(join(out, "secret.txt"), false, {})).ok).toBe(false);
    symlinkSync(join(out, "secret.txt"), join(d, "link.txt"));
    expect((await previewSlice(join(d, "link.txt"), false, {})).ok).toBe(false);
  });

  test("a dotted folder opens only for the local door, and a secret name never does", async () => {
    const d = tmp();
    mkdirSync(join(d, ".cfg"));
    writeFileSync(join(d, ".cfg", "x.txt"), "ok");
    writeFileSync(join(d, ".cfg", "id_rsa"), "-----BEGIN-----");
    expect((await previewSlice(join(d, ".cfg", "x.txt"), false, {})).ok).toBe(false);
    expect((await previewSlice(join(d, ".cfg", "x.txt"), true, {})).ok).toBe(true);
    expect((await previewSlice(join(d, ".cfg", "id_rsa"), true, {})).ok).toBe(false);
  });
});
