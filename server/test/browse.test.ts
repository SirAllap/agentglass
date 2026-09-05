/*
 * Looking at a place, and looking at a file.
 *
 * Two things are pinned here and they pull in opposite directions, which is
 * the whole difficulty of a file browser: it has to show you what is there —
 * sizes, dates, dimensions, the picture itself — and it must not become a way
 * to read `~/.ssh/id_rsa` from a browser tab.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDir, browseReal, fileBytes, fileFacts, imageSize, kindOf, openInDesktop } from "../src/browse.ts";

const made: string[] = [];
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;

/* A temp folder that this module is ALLOWED to look at.
 *
 * The boundary is real — home roots without dotted paths, or the open checkout
 * — so a test folder in /tmp is refused, correctly. `AGENTGLASS_DISK_ROOTS` is
 * the operator's own way of adding a root, and using it here means the suite
 * tests the real rule instead of a relaxed one. */
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-browse-"));
  made.push(d);
  process.env.AGENTGLASS_DISK_ROOTS = made.join(":");
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS;
  else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});

/* A real PNG header: 8-byte signature, then IHDR with the size. The smallest
   thing that proves the reader is reading and not guessing from the name. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("what is in this folder", () => {
  test("folders first, then files, each alphabetical", () => {
    const d = tmp();
    mkdirSync(join(d, "zeta"));
    mkdirSync(join(d, "alpha"));
    writeFileSync(join(d, "a-file.txt"), "x");
    writeFileSync(join(d, "b-file.txt"), "y");
    // Not a preference: it is what every file manager does, and the order
    // somebody's hand already knows.
    expect(browseDir(d).entries.map((e) => e.name)).toEqual(["alpha", "zeta", "a-file.txt", "b-file.txt"]);
  });

  test("a file carries its size, a folder how many things are in it", () => {
    const d = tmp();
    writeFileSync(join(d, "note.md"), "hello");
    mkdirSync(join(d, "shots"));
    writeFileSync(join(d, "shots", "one.png"), png(10, 10));
    writeFileSync(join(d, "shots", "two.png"), png(10, 10));
    const rows = browseDir(d).entries;
    expect(rows.find((e) => e.name === "note.md")).toMatchObject({ kind: "file", bytes: 5, items: null });
    // "2 items" is the number a person wants on a folder row; its own byte size
    // is an implementation detail of the filesystem.
    expect(rows.find((e) => e.name === "shots")).toMatchObject({ kind: "dir", bytes: null, items: 2 });
  });

  test("hidden entries are not listed, and the count says how many were left out", () => {
    const d = tmp();
    writeFileSync(join(d, "visible.txt"), "x");
    writeFileSync(join(d, ".secret"), "x");
    mkdirSync(join(d, ".config"));
    const r = browseDir(d);
    expect(r.entries.map((e) => e.name)).toEqual(["visible.txt"]);
    // Said out loud rather than silently showing less than the folder holds.
    expect(r.hiddenSkipped).toBe(2);
  });

  test("a symlink is shown as a link, not as what it points at", () => {
    const d = tmp();
    writeFileSync(join(d, "real.txt"), "x");
    symlinkSync(join(d, "real.txt"), join(d, "alias.txt"));
    expect(browseDir(d).entries.find((e) => e.name === "alias.txt")!.kind).toBe("link");
  });

  test("a file is not a folder, and says so", () => {
    const d = tmp();
    writeFileSync(join(d, "x.txt"), "x");
    expect(browseDir(join(d, "x.txt")).error).toBe("not a folder");
  });

  test("nothing there is 'no such folder', not an empty list", () => {
    // An empty list reads as "this folder is empty", which is a different fact.
    expect(browseDir(join(tmp(), "nope")).error).toBe("no such folder");
  });
});

describe("the boundary", () => {
  // No extra roots here: these assert what is refused when nothing was opened
  // and nothing was granted.
  const noRoots = () => { delete process.env.AGENTGLASS_DISK_ROOTS; };

  /* The finder's two worlds are the open checkout and the home roots without
     dotted paths. This module is a third door into those same two rooms — it
     must not be a way into a third one. */
  test("somewhere neither world contains is refused", () => {
    noRoots();
    expect(browseDir("/etc").ok).toBe(false);
    expect(browseDir("/etc").error).toContain("outside");
    expect(fileFacts("/etc/passwd").ok).toBe(false);
  });

  test("a dotted path inside home is refused, which is what keeps ~/.ssh out", () => {
    noRoots();
    const dotted = join(process.env.HOME ?? "/home/nobody", ".ssh");
    expect(browseDir(dotted).ok).toBe(false);
    expect(fileFacts(join(dotted, "id_rsa")).ok).toBe(false);
  });

  test("nonsense is refused before it reaches the filesystem", () => {
    noRoots();
    expect(browseDir(null).error).toBe("invalid path");
    expect(browseDir(42).error).toBe("invalid path");
    expect(fileFacts({}).error).toBe("invalid path");
  });

  /* The audit's shape: a cloned repository tracks `notes -> <somewhere outside>`.
     The spelling sits inside an allowed root and passed; `Bun.file` and
     `xdg-open` followed the link. The judgement is now on the real path. */
  test("a link whose target leaves both worlds is refused — the real path is judged, and served", async () => {
    const d = tmp();
    const outside = mkdtempSync(join(tmpdir(), "agx-browse-outside-"));
    try {
      writeFileSync(join(outside, "id_key"), "PRIVATE");
      symlinkSync(join(outside, "id_key"), join(d, "notes.txt"));
      expect(browseReal(join(d, "notes.txt"))).toBeNull();
      expect(fileFacts(join(d, "notes.txt")).error).toContain("outside");
      const bytes = await fileBytes(join(d, "notes.txt"));
      expect(bytes.ok).toBe(false);
      if (!bytes.ok) expect(bytes.error).toContain("outside");
      expect(openInDesktop(join(d, "notes.txt")).error).toContain("outside");
      // A link that stays inside is still a file this may show, by its real name.
      writeFileSync(join(d, "real.txt"), "hello");
      symlinkSync(join(d, "real.txt"), join(d, "alias.txt"));
      expect(browseReal(join(d, "alias.txt"))).toBe(join(d, "real.txt"));
      const ok = await fileBytes(join(d, "alias.txt"));
      expect(ok.ok).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("what a file is", () => {
  test("images the browser draws by itself", () => {
    for (const [name, mime] of [["a.png", "image/png"], ["b.JPG", "image/jpeg"], ["c.webp", "image/webp"],
      ["d.avif", "image/avif"], ["e.gif", "image/gif"], ["f.svg", "image/svg+xml"], ["g.bmp", "image/bmp"], ["h.ico", "image/x-icon"]]) {
      expect(kindOf(`/tmp/${name}`)).toEqual({ kind: "image", mime: mime! });
    }
  });

  /* The formats that ARE images and that a browser will not draw. Calling them
     "binary" is the answer that makes somebody think the app is broken; calling
     them convertible is what lets the panel offer the tool. */
  test("images that need a converter are still images", () => {
    for (const name of ["shot.tiff", "photo.heic", "art.psd", "raw.cr2", "scan.jp2"]) {
      expect(kindOf(`/tmp/${name}`).kind).toBe("image-convert");
    }
  });

  test("text, pdf, video and audio each by their own name", () => {
    expect(kindOf("/tmp/a.md").kind).toBe("text");
    expect(kindOf("/tmp/Makefile").kind).toBe("text");
    expect(kindOf("/tmp/a.pdf").kind).toBe("pdf");
    expect(kindOf("/tmp/a.mp4").kind).toBe("video");
    expect(kindOf("/tmp/a.flac").kind).toBe("audio");
  });

  /* A file with no extension is the case where the name cannot answer, and it
     is common: a LICENSE, a script, a dump. The bytes answer instead. */
  test("with no extension, the bytes decide", () => {
    expect(kindOf("/tmp/LICENSE", Buffer.from("The MIT License\n\nPermission is hereby granted")).kind).toBe("text");
    expect(kindOf("/tmp/blob", Buffer.from([0x00, 0x01, 0x02, 0x00]))).toMatchObject({ kind: "binary" });
    expect(kindOf("/tmp/nameless", png(1, 1)).mime).toBe("image/png");
  });
});

describe("how big an image is, from its own header", () => {
  test("png", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  test("gif and bmp, which are little-endian where png is big", () => {
    const gif = Buffer.alloc(12);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(640, 6);
    gif.writeUInt16LE(480, 8);
    expect(imageSize(gif)).toEqual({ width: 640, height: 480 });

    const bmp = Buffer.alloc(30);
    bmp.write("BM", 0, "ascii");
    bmp.writeInt32LE(800, 18);
    // Height is signed: a negative one means top-down rows, not a negative size.
    bmp.writeInt32LE(-600, 22);
    expect(imageSize(bmp)).toEqual({ width: 800, height: 600 });
  });

  test("jpeg, whose size is not at a fixed offset", () => {
    // Signature, one segment to skip, then the frame header. Walking is the
    // whole point: a jpeg with EXIF has the size hundreds of bytes further in.
    const b = Buffer.alloc(64, 0);
    b[0] = 0xff; b[1] = 0xd8;
    b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(16, 4);          // APP0, 16 bytes
    const sof = 20;
    b[sof] = 0xff; b[sof + 1] = 0xc0; b.writeUInt16BE(17, sof + 2);
    b.writeUInt16BE(768, sof + 5);
    b.writeUInt16BE(1024, sof + 7);
    expect(imageSize(b)).toEqual({ width: 1024, height: 768 });
  });

  test("svg has no pixels, so its declared box is the answer", () => {
    expect(imageSize(Buffer.from('<svg width="120" height="40" xmlns="http://www.w3.org/2000/svg">')))
      .toEqual({ width: 120, height: 40 });
    expect(imageSize(Buffer.from('<svg viewBox="0 0 64 32" xmlns="http://www.w3.org/2000/svg">')))
      .toEqual({ width: 64, height: 32 });
  });

  test("and something that is not an image has no size to give", () => {
    expect(imageSize(Buffer.from("hello"))).toBe(null);
  });
});

describe("the facts a preview needs", () => {
  test("a text file arrives with its text, so the panel needs no second call", () => {
    const d = tmp();
    writeFileSync(join(d, "note.md"), "# Title\n\nbody");
    const f = fileFacts(join(d, "note.md"));
    expect(f).toMatchObject({ ok: true, kind: "text", name: "note.md", bytes: 13 });
    expect(f.text).toContain("# Title");
  });

  test("an image arrives with its dimensions and never with its bytes", () => {
    const d = tmp();
    writeFileSync(join(d, "shot.png"), png(1920, 1080));
    const f = fileFacts(join(d, "shot.png"));
    expect(f).toMatchObject({ ok: true, kind: "image", mime: "image/png", width: 1920, height: 1080 });
    // The bytes are a separate request on purpose: a facts call happens on every
    // arrow-key move, and a 12MB screenshot must not ride along with it.
    expect(f.text).toBeUndefined();
  });

  test("a format needing conversion says which tool would do it", () => {
    const d = tmp();
    writeFileSync(join(d, "scan.tiff"), Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    const f = fileFacts(join(d, "scan.tiff"));
    expect(f.kind).toBe("image-convert");
    // Either a tool on this machine, or null — never a promise the panel cannot keep.
    expect(f.converter === null || typeof f.converter === "string").toBe(true);
  });

  test("a folder is a folder, not an unreadable file", () => {
    expect(fileFacts(tmp())).toMatchObject({ ok: true, kind: "dir" });
  });
});

describe("handing a file to the desktop", () => {
  test("outside the boundary is refused before anything is spawned", () => {
    noRootsForOpen();
    expect(openInDesktop("/etc/passwd")).toMatchObject({ ok: false });
    expect(openInDesktop("/etc/passwd").error).toContain("outside");
    expect(openInDesktop(null)).toMatchObject({ ok: false });
  });

  test("a file that is not there is not opened", () => {
    const d = tmp();
    expect(openInDesktop(join(d, "nope.png"))).toMatchObject({ ok: false, error: "no such file" });
  });
});
function noRootsForOpen() { delete process.env.AGENTGLASS_DISK_ROOTS; }
