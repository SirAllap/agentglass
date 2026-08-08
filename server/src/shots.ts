/*
 * Somewhere to put an image so an agent can read it.
 *
 * A tmux window takes text. Handing a marked-up screenshot to an agent by
 * pasting a megabyte of base64 into a shell is not a thing anybody wants to
 * watch happen, and the prompt would be unreadable afterwards. So the image
 * lands on disk and the agent is told the path — which it can open, because
 * reading a file is the one thing every agent can already do.
 *
 * Under the cache directory rather than the config one: these are disposable by
 * design. The old ones are swept on write, so a week of pointing at pages does
 * not quietly become a gigabyte.
 */
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "agentglass",
  "shots",
);

/** Test seam, so a suite never writes into the developer's own cache. */
let override: string | null = null;
export function __setShotDir(p: string | null): void { override = p; }
const dir = (): string => override ?? DIR;

/**
 * Four megabytes.
 *
 * A full-window PNG of a 4K display is around two; past four this is not a
 * screenshot of a page any more and the caller has a bug worth reporting rather
 * than a file worth keeping.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/** A day. Long enough to still be there when you come back from lunch, short
 *  enough that nobody ever thinks about this directory. */
const KEEP_MS = 24 * 3600_000;

/** Only what a filename may be. Everything else in the caller's name is
 *  dropped rather than escaped: a name is a convenience here, not data. */
const slug = (s: string): string => (s
  // Dots go first and as a run: `.` is fine inside a name, and `..` is the one
  // sequence that means something to a path. Dropping it here rather than
  // relying on join() means the FILENAME never reads like a traversal either.
  .replace(/\.{2,}/g, "-")
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/^[-.]+|[-.]+$/g, "")
  .slice(0, 40) || "shot");

function sweep(now: number): void {
  try {
    for (const f of readdirSync(dir())) {
      const p = join(dir(), f);
      try { if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p); } catch { /* raced with another sweep */ }
    }
  } catch { /* nothing there yet */ }
}

export interface SavedShot { ok: boolean; path?: string; error?: string }

/**
 * Write a PNG data URL, and answer with where it went.
 *
 * PNG only, and checked by the prefix rather than trusted: this writes a file
 * to disk from a string the renderer supplied, so the one thing it must not do
 * is write whatever it was given under a name it was also given.
 */
export function saveShot(dataUrl: unknown, name: unknown, now = Date.now()): SavedShot {
  if (typeof dataUrl !== "string") return { ok: false, error: "no image" };
  const head = "data:image/png;base64,";
  if (!dataUrl.startsWith(head)) return { ok: false, error: "only PNG images are accepted" };
  let bytes: Buffer;
  try { bytes = Buffer.from(dataUrl.slice(head.length), "base64"); }
  catch { return { ok: false, error: "that is not valid base64" }; }
  if (!bytes.length) return { ok: false, error: "the image is empty" };
  if (bytes.length > MAX_BYTES) return { ok: false, error: `the image is ${(bytes.length / 1e6).toFixed(1)} MB — too big to keep` };
  // A PNG starts with these eight bytes. Cheap, and it means a file with a .png
  // name is really one.
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(magic)) return { ok: false, error: "that is not a PNG" };

  try {
    mkdirSync(dir(), { recursive: true });
    sweep(now);
    const path = join(dir(), `${slug(typeof name === "string" ? name : "shot")}-${now.toString(36)}.png`);
    writeFileSync(path, bytes);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: `could not write the image: ${String(e)}` };
  }
}
