/*
 * Looking at a place, and looking at a file — for BOTH worlds the finder can
 * see.
 *
 * The finder has four tabs and, until now, two unrelated backends: `/files/*`
 * bounded by the open checkout, `/disk/*` bounded by your home folder. That
 * split is invisible to whoever is using it and it is why the tabs behave
 * differently — one can open a folder, the other narrows a search; one can read
 * a file, the other only names it.
 *
 * So this module answers the two questions that were missing, once, for both:
 *
 *     browseDir(path)   what is in this folder — with sizes and dates
 *     fileFacts(path)   what is this file — and enough of it to show
 *
 * The boundary is the union of the two that already exist: a path is allowed if
 * it is inside the open project (inScope, the checkout world) OR inside the
 * home roots with no dotted segment (diskAllows, the documents world). Neither
 * rule is loosened here — this is a third door into the same two rooms, not a
 * new room.
 */
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { failed } from "./refused.ts";
import { basename, dirname, extname, join, resolve } from "node:path";
import { diskAllows, diskRoots } from "./disk.ts";
import { safeAbs } from "./git.ts";
import { inScope, workspaceRoot } from "./config.ts";

/** How many entries one folder hands back. A directory with 40,000 files in it
 *  is not a list anybody reads, and the count says what was left. */
const MAX_ENTRIES = 2000;
/** How much of a text file travels for a preview. Enough to read, not enough to
 *  make the socket the slow part. */
const TEXT_HEAD = 256 * 1024;

export type EntryKind = "dir" | "file" | "link";

export interface BrowseEntry {
  name: string;
  kind: EntryKind;
  /** Bytes for a file; for a directory, how many entries are in it — the number
   *  a person actually wants there, and the one every file manager shows. */
  bytes: number | null;
  items: number | null;
  /** Epoch millis. Rendered relative on the client, which is where the clock is. */
  mtime: number;
  /** True when the name starts with a dot. Never listed today (the boundary
   *  excludes them) but the field exists so the UI can say so rather than
   *  quietly showing less than the folder holds. */
  hidden: boolean;
}

export interface BrowseReport {
  ok: boolean;
  path: string;
  /** The folder above, or null at a boundary — which is what stops `..` from
   *  walking somebody out of their home directory one keystroke at a time. */
  parent: string | null;
  entries: BrowseEntry[];
  /** How many were left out by the cap, and how many by the hidden rule. */
  more: number;
  hiddenSkipped: number;
  error?: string;
}

/**
 * May the finder look here?
 *
 * The union of the two boundaries the app already enforces, and deliberately
 * nothing more. `inScope` is the open project and everything under it;
 * `diskAllows` is the home roots with every dotted path taken out, which is
 * what keeps `~/.ssh` and `~/.aws` out of a file browser.
 */
export function browseAllows(p: unknown): boolean {
  return browseReal(p) !== null;
}

/**
 * The path with its symlinks resolved — the deepest ancestor that exists
 * resolved, the rest appended — so a file that is not there yet is judged by
 * where it WOULD be, and refused as "no such file" rather than "outside".
 * Same shape as disk.ts's, kept private there for the same reason it is here:
 * it is a step in a check, not a check.
 */
function realOf(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(head), ...tail); } catch { /* climb */ }
    const up = dirname(head);
    if (up === head) return abs;
    tail.unshift(head.slice(up.length + 1));
    head = up;
  }
  return abs;
}

/**
 * The REAL path this may look at, or null.
 *
 * Judged after the symlinks are resolved, and it is the resolved path that
 * gets read or handed to the desktop. `diskAllows` always did this; the
 * checkout door did not, and a cloned repository that tracks
 * `notes -> ~/.ssh/id_rsa` passed `inScope` on its spelling while `Bun.file`
 * followed the link. A link whose target leaves both worlds is refused the
 * same as typing the target would be.
 */
export function browseReal(p: unknown): string | null {
  const abs = safeAbs(p);
  if (!abs) return null;
  const real = realOf(abs);
  if (diskAllows(real)) return real;
  /*
   * The checkout door, and it is CLOSED when there is no checkout.
   *
   * `inScope(p)` answers true for everything when no workspace root is set —
   * "whole-machine: nothing to enforce", which is right for a cockpit watching
   * every project on the box and wrong for a file browser: the first version of
   * this function used it and happily listed /etc. Passing the root explicitly
   * makes the absence of one mean "no door" instead of "every door", which is
   * what the test that caught it now pins.
   */
  const root = workspaceRoot();
  return root && inScope(real, root) ? real : null;
}

/** The folder above, unless that would leave everywhere this may look. */
function parentOf(abs: string): string | null {
  const up = dirname(abs);
  if (up === abs) return null;
  return browseAllows(up) ? up : null;
}

/**
 * List a folder.
 *
 * Sizes and dates come from `lstat`, not `stat`: a symlink's own metadata is
 * what the row is about, and following it is how a browser ends up reporting
 * the size of something in a place it is not allowed to look at.
 */
export function browseDir(pathIn: unknown): BrowseReport {
  const abs = safeAbs(pathIn);
  const empty = { ok: false, path: String(abs ?? ""), parent: null, entries: [], more: 0, hiddenSkipped: 0 };
  if (!abs) return { ...empty, error: "invalid path" };
  if (!browseAllows(abs)) return { ...empty, error: "outside the places this may look" };

  let names: string[];
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return { ...empty, error: "not a folder" };
    names = readdirSync(abs);
  } catch (e) {
    return { ...empty, error: (e as NodeJS.ErrnoException)?.code === "EACCES" ? "no permission to read this folder" : "no such folder" };
  }

  const entries: BrowseEntry[] = [];
  let hiddenSkipped = 0;
  let more = 0;
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) { hiddenSkipped++; continue; }
    if (entries.length >= MAX_ENTRIES) { more++; continue; }
    const full = join(abs, name);
    try {
      const st = lstatSync(full);
      const link = st.isSymbolicLink();
      // A symlink is followed ONLY to decide whether it behaves as a folder,
      // and only when its target is somewhere this may look. Anything else is
      // shown as what it is.
      const target = link && browseAllows(realish(full)) ? safeStat(full) : null;
      const dir = st.isDirectory() || (target?.isDirectory() ?? false);
      entries.push({
        name,
        kind: link ? "link" : dir ? "dir" : "file",
        bytes: dir ? null : (target ?? st).size,
        items: dir ? countItems(full) : null,
        mtime: st.mtimeMs,
        hidden: false,
      });
    } catch { /* vanished between readdir and lstat: it is not there, so it is not a row */ }
  }

  // Folders first, then files, each alphabetical — the order every file
  // manager uses, and the one that makes a folder findable by muscle memory.
  entries.sort((a, b) => (a.kind === "dir") === (b.kind === "dir")
    ? a.name.localeCompare(b.name)
    : a.kind === "dir" ? -1 : 1);

  return { ok: true, path: abs, parent: parentOf(abs), entries, more, hiddenSkipped };
}

const safeStat = (p: string) => { try { return statSync(p); } catch { return null; } };
const realish = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** How many things are in a folder, for the row. Bounded: this runs once per
 *  visible row and a home directory full of caches must not make a listing
 *  crawl. */
function countItems(abs: string): number | null {
  try {
    let n = 0;
    for (const name of readdirSync(abs)) {
      if (name.startsWith(".")) continue;
      if (++n >= 9999) break;
    }
    return n;
  } catch { return null; }
}

/* -------------------------------------------------------------------------
 * What a file is.
 * ---------------------------------------------------------------------- */

/**
 * The types a browser draws by itself.
 *
 * These are the ones an `<img>` renders with no help: everything else that is
 * an image still gets recognised as one and offered a conversion, so "can I see
 * my screenshots" is answered yes for every format on this list and "not here,
 * but here is how" for the rest.
 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".cur": "image/x-icon",
  ".svg": "image/svg+xml",
  ".apng": "image/apng",
};

/** Images the browser will not draw, but a tool on this machine can convert.
 *  Named so the answer is "not directly" rather than "not an image". */
const IMAGE_CONVERTIBLE = new Set([
  ".tif", ".tiff", ".heic", ".heif", ".psd", ".xcf", ".dds", ".tga", ".pcx", ".ppm", ".pgm", ".pbm",
  ".jp2", ".j2k", ".jxl", ".exr", ".hdr",
  // Camera raw. Rarely on a developer's machine and unmistakably an image when
  // it is, which is exactly when a viewer saying "binary file" is unhelpful.
  ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".raf", ".rw2", ".sr2",
]);

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".pl", ".lua", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".xml", ".svg", ".patch", ".diff", ".gitignore", ".dockerfile", ".makefile", ".mk", ".gradle",
]);

export type PreviewKind = "image" | "image-convert" | "text" | "pdf" | "video" | "audio" | "binary" | "dir";

export interface FileFacts {
  ok: boolean;
  path: string;
  name: string;
  kind: PreviewKind;
  /** What to serve the bytes as, when they are served at all. */
  mime: string;
  bytes: number;
  mtime: number;
  /** Pixels, read out of the file's own header — no decoder, no dependency. */
  width?: number;
  height?: number;
  /** The head of a text file, already decoded. */
  text?: string;
  textTruncated?: boolean;
  /** For a format the browser cannot draw: the tool that could convert it, or
   *  null when this machine has none. */
  converter?: string | null;
  error?: string;
}

/** Is there a tool on this machine that can turn an odd image into a PNG? */
let converterCache: string | null | undefined;
export function imageConverter(): string | null {
  if (converterCache === undefined) {
    converterCache = ["magick", "convert", "heif-convert", "ffmpeg"]
      .map((bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }))
      .find((p): p is string => !!p) ?? null;
  }
  return converterCache;
}
/** Test seam. */
export function __resetConverterForTest(): void { converterCache = undefined; }

/** What this file is, by extension first and by its own bytes when that is not
 *  enough. Extension first because it is free and right nearly always; the
 *  bytes decide the case that matters — a file with no extension at all. */
export function kindOf(abs: string, head?: Buffer): { kind: PreviewKind; mime: string } {
  const ext = extname(abs).toLowerCase();
  if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext]! };
  if (IMAGE_CONVERTIBLE.has(ext)) return { kind: "image-convert", mime: "application/octet-stream" };
  if (ext === ".pdf") return { kind: "pdf", mime: "application/pdf" };
  if ([".mp4", ".webm", ".mkv", ".mov", ".m4v"].includes(ext)) return { kind: "video", mime: ext === ".webm" ? "video/webm" : "video/mp4" };
  if ([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".opus"].includes(ext)) return { kind: "audio", mime: "audio/*" };
  if (TEXT_EXT.has(ext) || basename(abs).toLowerCase() === "makefile" || basename(abs).toLowerCase() === "dockerfile") {
    return { kind: "text", mime: "text/plain; charset=utf-8" };
  }
  // No extension, or one nobody has heard of: ask the bytes. A NUL in the first
  // few KB is the oldest and still the best "this is not text" test there is.
  if (head && head.length) {
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
    if (head[0] === 0xff && head[1] === 0xd8) return { kind: "image", mime: "image/jpeg" };
    if (head.subarray(0, 4).toString("ascii") === "%PDF") return { kind: "pdf", mime: "application/pdf" };
    if (!head.subarray(0, 4096).includes(0)) return { kind: "text", mime: "text/plain; charset=utf-8" };
  }
  return { kind: "binary", mime: "application/octet-stream" };
}

/**
 * The dimensions of an image, from its header.
 *
 * Read here rather than in the browser because the panel wants to say
 * "1920×1080" beside a file it has not loaded yet — in a list, in a tooltip,
 * for something it may never draw. Four formats cover essentially everything a
 * screenshot or an export is; the rest simply have no dimensions to show,
 * which is better than a dependency that decodes them.
 */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: IHDR is always first and always at 16.
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: little-endian, right after the signature.
  if (buf.length > 10 && buf.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // BMP.
  if (buf.length > 26 && buf.subarray(0, 2).toString("ascii") === "BM") {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  // WEBP, both the lossy and the lossless chunk layouts.
  if (buf.length > 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8 " && buf.length > 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buf.length > 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && buf.length > 30) {
      return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
  }
  // JPEG: walk the segments to the frame header, which is the only place the
  // size lives and is not at a fixed offset.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      // SOF0..SOF15, minus the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  // SVG has no pixels, but it does declare a box, and that is what a viewer
  // needs to size the frame it draws into.
  const text = buf.subarray(0, 2048).toString("utf8");
  if (text.includes("<svg")) {
    const w = /\bwidth="([\d.]+)/.exec(text)?.[1];
    const h = /\bheight="([\d.]+)/.exec(text)?.[1];
    if (w && h) return { width: Math.round(Number(w)), height: Math.round(Number(h)) };
    const box = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(text);
    if (box) return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) };
  }
  return null;
}

/**
 * Everything the preview pane needs about one file, in one call.
 *
 * Including the text itself when it is text: a second round trip to fetch the
 * body of a 3KB note is a spinner nobody needed.
 */
export function fileFacts(pathIn: unknown): FileFacts {
  const abs = safeAbs(pathIn);
  const empty: FileFacts = { ok: false, path: String(abs ?? ""), name: "", kind: "binary", mime: "", bytes: 0, mtime: 0 };
  if (!abs) return { ...empty, error: "invalid path" };
  if (!browseAllows(abs)) return { ...empty, error: "outside the places this may look" };

  let st;
  try { st = statSync(abs); } catch { return { ...empty, error: "no such file" }; }
  const base = { ok: true, path: abs, name: basename(abs), bytes: st.size, mtime: st.mtimeMs };
  if (st.isDirectory()) return { ...base, kind: "dir", mime: "inode/directory" };

  let head: Buffer | undefined;
  try {
    const fd = readFileSync(abs, { flag: "r" });
    head = fd.subarray(0, Math.min(fd.length, 64 * 1024));
    const { kind, mime } = kindOf(abs, head);

    if (kind === "image") {
      const size = imageSize(fd) ?? undefined;
      return { ...base, kind, mime, ...(size ?? {}) };
    }
    if (kind === "image-convert") {
      return { ...base, kind, mime: "image/png", converter: imageConverter() };
    }
    if (kind === "text") {
      const text = fd.subarray(0, TEXT_HEAD).toString("utf8");
      return { ...base, kind, mime, text, textTruncated: fd.length > TEXT_HEAD };
    }
    return { ...base, kind, mime };
  } catch (e) {
    // A file too big to read whole, or one that vanished. Say which rather than
    // letting the panel show an empty preview that looks like a bug.
    const { kind, mime } = kindOf(abs, head);
    return { ...base, kind, mime, error: (e as NodeJS.ErrnoException)?.code === "EACCES" ? "no permission to read this file" : undefined };
  }
}

/**
 * The bytes, for the browser to draw.
 *
 * Converted first when the format is one the browser cannot: `magick`,
 * `convert`, `heif-convert` or `ffmpeg`, whichever this machine has. Nothing is
 * ever installed or downloaded to satisfy a preview — with no tool the panel
 * says so and offers to open it in whatever the desktop uses.
 */
export async function fileBytes(pathIn: unknown): Promise<{ ok: true; body: Uint8Array | ArrayBuffer; mime: string } | { ok: false; error: string }> {
  // What was judged is what is read: the real path, links resolved.
  const abs = browseReal(pathIn);
  if (!abs) return { ok: false, error: "outside the places this may look" };
  let st;
  try { st = statSync(abs); } catch { return { ok: false, error: "no such file" }; }
  if (st.isDirectory()) return { ok: false, error: "that is a folder" };

  const { kind, mime } = kindOf(abs, readHead(abs));
  if (kind !== "image-convert") {
    return { ok: true, body: await Bun.file(abs).arrayBuffer(), mime };
  }

  const tool = imageConverter();
  if (!tool) return { ok: false, error: "no image converter on this machine (magick, convert, heif-convert or ffmpeg)" };
  const argv = tool.endsWith("ffmpeg")
    ? [tool, "-v", "error", "-i", abs, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
    : tool.endsWith("heif-convert")
      ? [tool, abs, "/dev/stdout"]
      // ImageMagick: the first frame only. A multi-page TIFF converted whole is
      // a hundred megabytes for a thumbnail nobody asked for.
      : [tool, `${abs}[0]`, "png:-"];
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).arrayBuffer();
  if ((await p.exited) !== 0 || out.byteLength === 0) {
    return { ok: false, error: `${basename(tool)} could not convert this image` };
  }
  return { ok: true, body: out, mime: "image/png" };
}

function readHead(abs: string): Buffer | undefined {
  try { return readFileSync(abs).subarray(0, 64 * 1024); } catch { return undefined; }
}

/** The places a browse can start from: the same list the machine search offers,
 *  so both halves of the finder agree about where "here" can be. */
export function browseRoots(): string[] {
  return diskRoots().map((r) => resolve(r));
}

/**
 * Hand a file to whatever this desktop opens it with.
 *
 * The alternative was the editor, and for a screenshot the editor is nvim —
 * which is how "abrir" on a PNG ended up drawing a floating modal with a binary
 * in it. A picture belongs to the picture viewer.
 *
 * Routed through here rather than through Electron's `shell.openExternal`
 * because that one deliberately refuses `file://`: the strings reaching it come
 * out of pull request bodies and git remotes, written by other people. This
 * path is different in exactly the way that matters — the path is checked
 * against the same boundary as every other read, and it is only ever a path
 * this server would have shown you anyway.
 */
export function openInDesktop(pathIn: unknown): { ok: boolean; with?: string; error?: string } {
  // The desktop opens the real file, the one that was judged — not a link
  // that was judged by its name and points somewhere else.
  const abs = browseReal(pathIn);
  if (!abs) return { ok: false, error: "outside the places this may look" };
  try { statSync(abs); } catch { return { ok: false, error: "no such file" }; }

  const opener = process.platform === "darwin"
    ? Bun.which("open", { PATH: process.env.PATH ?? "" })
    : Bun.which("xdg-open", { PATH: process.env.PATH ?? "" }) ?? Bun.which("gio", { PATH: process.env.PATH ?? "" });
  if (!opener) return { ok: false, error: "no desktop opener on this machine (xdg-open or gio)" };

  try {
    // Detached and with its output thrown away: the viewer outlives this
    // request, and a photo viewer's stdout has no business in the engine's log.
    Bun.spawn(opener.endsWith("gio") ? [opener, "open", abs] : [opener, abs], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    return { ok: true, with: basename(opener) };
  } catch (e) {
    return { ok: false, error: failed("preview/open", e, "the desktop could not open that file") };
  }
}
