/*
 * The guards on a page-ticket read, each broken on its own:
 * - the bytes stream from the open handle, which closes at the end or on cancel;
 * - ImageMagick is told the reader by extension, never left to sniff the bytes;
 * - ffmpeg is told the demuxer by extension and may read only its stdin;
 * - a converter that exits before reading its input does not take the server down;
 * - the converter's error output is not piped, and it is killed after a time limit;
 * - a made-up ticket opens nothing, and "no such file", "not a regular file"
 *   and "another file" answer with one sentence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetConverterForTest, __setConvertTimeoutForTest, ffmpegArgv, magickArgv, pageByTicket, pageFacts } from "../src/browse.ts";
import { PAGE_TICKET_STALE, pageTicket, pageTicketPathRefusal, pageTicketRefusal, type PageFacts } from "../src/auth.ts";

const was = { cfg: process.env.XDG_CONFIG_HOME, state: process.env.AGENTGLASS_STATE_DIR, roots: process.env.AGENTGLASS_DISK_ROOTS, path: process.env.PATH };
const root = mkdtempSync(join(tmpdir(), "agx-pageguards-"));
const docs = join(root, "docs");
const bin = join(root, "bin");
const tok = "machine-token";

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = join(root, "cfg");
  process.env.AGENTGLASS_STATE_DIR = join(root, "state");
  process.env.AGENTGLASS_DISK_ROOTS = docs;
  mkdirSync(docs, { recursive: true });
  mkdirSync(bin, { recursive: true });
});
afterEach(() => {
  process.env.PATH = was.path;
  __resetConverterForTest();
  __setConvertTimeoutForTest(5_000);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["XDG_CONFIG_HOME", was.cfg], ["AGENTGLASS_STATE_DIR", was.state], ["AGENTGLASS_DISK_ROOTS", was.roots]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const serve = (path: string, t: string) =>
  pageByTicket(path, () => pageTicketPathRefusal(tok, path, t, false), (f) => pageTicketRefusal(tok, f, t, false), () => false);
const ticketFor = (path: string) => pageTicket(tok, pageFacts(path)!, false);
/** Open handles of this process on `file`. */
const handlesOn = (file: string) => readdirSync("/proc/self/fd").filter((n) => { try { return readlinkSync(`/proc/self/fd/${n}`) === file; } catch { return false; } }).length;
/** A stand-in converter named `magick` on PATH, from a shell body. */
function fakeMagick(body: string) {
  const p = join(bin, "magick");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  process.env.PATH = `${bin}:${was.path}`;
  __resetConverterForTest();
}

describe("the bytes stream from the open handle", () => {
  test("a 3 GB file answers its first chunk without reading the rest, and cancel closes the handle", async () => {
    const big = join(docs, "big.mp4");
    writeFileSync(big, "");
    truncateSync(big, 3 * 1024 ** 3); // sparse: no disk used
    const started = performance.now();
    const r = await serve(big, ticketFor(big));
    expect(r).toBeInstanceOf(Response);
    const reader = (r as Response).body!.getReader();
    const first = await reader.read();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    expect(first.value!.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(handlesOn(big)).toBe(1);
    await reader.cancel();
    await Bun.sleep(50);
    expect(handlesOn(big)).toBe(0);
  });

  test("a whole read gives every byte and closes the handle at the end", async () => {
    const mid = join(docs, "mid.txt");
    const text = "abcdefghij".repeat(100_000); // 1 MB, several chunks
    writeFileSync(mid, text);
    const r = await serve(mid, ticketFor(mid));
    expect(await (r as Response).text()).toBe(text);
    expect(handlesOn(mid)).toBe(0);
  });
});

describe("ImageMagick is told the reader", () => {
  test("the argv names the reader from the extension; an extension not on the list is refused", () => {
    expect(magickArgv("magick", "/a/x.heic", "-")).toEqual(["magick", "heic:-[0]", "png:-"]);
    expect(magickArgv("convert", "/a/x.TIFF", "/a/x.TIFF")).toEqual(["convert", "tiff:/a/x.TIFF[0]", "png:-"]);
    expect(magickArgv("magick", "/a/x.svg", "-")).toBeNull();
    expect(magickArgv("magick", "/a/x", "-")).toBeNull();
  });

  test("the reader prefix reaches the converter, and its error output is not piped", async () => {
    const seen = join(root, "argv");
    // 1 MB on stderr, which nobody reads: it must not stop the picture.
    fakeMagick(`printf '%s\\n' "$@" > '${seen}'; cat > /dev/null; /usr/bin/head -c 1048576 /dev/zero >&2; printf PNGDATA`);
    const pic = join(docs, "photo.heic");
    writeFileSync(pic, "not really a picture");
    const r = await serve(pic, ticketFor(pic));
    expect(r).toBeInstanceOf(Response);
    expect(await (r as Response).text()).toBe("PNGDATA");
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["heic:-[0]", "png:-"]);
    expect(handlesOn(pic)).toBe(0);
  });

  test("no converter's error output is piped: Bun would hold all of it in memory, unread", () => {
    const src = readFileSync(join(import.meta.dir, "../src/browse.ts"), "utf8");
    const at = src.indexOf("async function runConverter(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain('stderr: "ignore"');
    // Every converter goes through runConverter: no other spawn in the file pipes stderr.
    expect(src.includes('stderr: "pipe"')).toBe(false);
  });

  test("a converter that hangs is killed after the time limit and the handle closes", async () => {
    fakeMagick("exec sleep 30");
    __setConvertTimeoutForTest(300);
    const pic = join(docs, "slow.heic");
    writeFileSync(pic, "x".repeat(1024));
    const started = performance.now();
    const r = await serve(pic, ticketFor(pic));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(r).toMatchObject({ status: 404 });
    expect((r as { error: string }).error).toMatch(/took longer/);
    expect(handlesOn(pic)).toBe(0);
  });

  test.skipIf(!Bun.which("magick") && !Bun.which("convert"))("a real ImageMagick does not read an .heic that is SVG as SVG", async () => {
    __resetConverterForTest();
    const secret = join(root, "secret.txt");
    // Assembled at runtime so a secret scanner on the public repo does not flag it.
    writeFileSync(secret, ["PRIVATE", "KEY-0123456789"].join("-"));
    const pic = join(docs, "evil.heic");
    writeFileSync(pic, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="40"><image width="200" height="40" xlink:href="text:${secret}"/></svg>`);
    const r = await serve(pic, ticketFor(pic));
    // The HEIC reader finds no picture: refused, nothing drawn.
    expect(r).not.toBeInstanceOf(Response);
    expect(r).toMatchObject({ status: 404 });
    expect(handlesOn(pic)).toBe(0);
  });
});

describe("a ticket is proven before anything is opened", () => {
  const fake = (real: string): PageFacts => ({ real, size: 1, mtimeMs: 1, dev: 1, ino: 1 });

  test("a made-up ticket answers the same for a file that is there and one that is not", async () => {
    const there = join(docs, "there.txt");
    writeFileSync(there, "hi");
    const forged = `${Date.now() + 60_000}.${"0".repeat(64)}.${"0".repeat(64)}`;
    const a = await serve(there, forged);
    const b = await serve(join(docs, "missing.txt"), forged);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 401 });
    expect((a as { error: string }).error).toMatch(/not valid/);
  });

  test("no such file and another file: one sentence", async () => {
    const missing = join(docs, "gone.txt");
    const other = join(docs, "other.txt");
    writeFileSync(other, "hi");
    // Path half fits (signed for these words), file half does not.
    const a = await serve(missing, pageTicket(tok, fake(missing), false));
    const b = await serve(other, pageTicket(tok, fake(other), false));
    expect(a).toEqual({ status: 401, error: PAGE_TICKET_STALE });
    expect(b).toEqual({ status: 401, error: PAGE_TICKET_STALE });
  });

  test("a fifo is not a regular file: refused with the same sentence, nothing hangs", async () => {
    const fifo = join(docs, "pipe.html");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(pageFacts(fifo)).toBeNull();
    const r = await serve(fifo, pageTicket(tok, fake(fifo), false));
    expect(r).toEqual({ status: 401, error: PAGE_TICKET_STALE });
    expect(handlesOn(fifo)).toBe(0);
  });
});

describe("ffmpeg is told the demuxer and reads only stdin", () => {
  test("the argv names the demuxer from the extension and allows only the pipe; an extension not on the list is refused", () => {
    expect(ffmpegArgv("ffmpeg", "/a/x.TIF")).toEqual(["ffmpeg", "-v", "error", "-protocol_whitelist", "pipe", "-f", "tiff_pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    expect(ffmpegArgv("ffmpeg", "/a/x.jxl")).toContain("jpegxl_pipe");
    expect(ffmpegArgv("ffmpeg", "/a/x.heic")).toBeNull();
    expect(ffmpegArgv("ffmpeg", "/a/x.m3u8")).toBeNull();
    expect(ffmpegArgv("ffmpeg", "/a/x")).toBeNull();
  });
});

describe("a converter that stops reading early", () => {
  // In a child process: an EPIPE from Bun's own stdin pipe kills the process
  // outright, so the test runner would die with it instead of failing.
  test("the server process stays alive when the converter exits or is killed with input pending", async () => {
    const script = `
      import { runConverter, __setConvertTimeoutForTest } from ${JSON.stringify(join(import.meta.dir, "../src/browse.ts"))};
      const big = () => { let n = 0; return new ReadableStream({ pull(c) { if (n++ >= 64) return c.close(); c.enqueue(new Uint8Array(256 * 1024)); } }); };
      for (let i = 0; i < 5; i++) await runConverter(["head", "-c", "10"], big());
      // Run sleep itself, not sh -c: where sh does not exec its last command (a container), the kill takes only the shell and the orphaned sleep keeps the pipe open for 30 s.
      __setConvertTimeoutForTest(200);
      for (let i = 0; i < 3; i++) await runConverter(["sleep", "30"], big());
      await Bun.sleep(300);
      console.log("alive");
    `;
    const file = join(root, "early-exit.ts");
    writeFileSync(file, script);
    const p = Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(out.trim()).toBe("alive");
    expect(code).toBe(0);
  }, 20_000);
});
