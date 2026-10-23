/*
 * Saving a file from the finder's editor. The read route's boundary applies to
 * the write, and on top of it: a file that moved on disk is not overwritten,
 * nothing bigger than the preview reads is written, and a file that is not
 * UTF-8 is left alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDIT_CAP, saveText } from "../src/browse.ts";

const made: string[] = [];
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-save-"));
  made.push(d);
  process.env.AGENTGLASS_DISK_ROOTS = made.join(":");
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS;
  else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});
const mtimeOf = (p: string) => statSync(p).mtimeMs;

describe("saveText", () => {
  test("writes the text in place and keeps the mode", () => {
    const d = tmp(); const f = join(d, "run.sh");
    writeFileSync(f, "echo old\n"); chmodSync(f, 0o755);
    const r = saveText(f, "echo new\n", mtimeOf(f));
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("echo new\n");
    expect(statSync(f).mode & 0o777).toBe(0o755);
    if (r.ok) expect(r.mtime).toBe(mtimeOf(f));
  });

  test("refuses when the file changed on disk since it was opened", () => {
    const d = tmp(); const f = join(d, "a.txt");
    writeFileSync(f, "one"); const seen = mtimeOf(f);
    writeFileSync(f, "two"); utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const r = saveText(f, "mine", seen);
    expect(r).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(f, "utf8")).toBe("two");
  });

  test("refuses a path outside the places the finder may look", () => {
    tmp();
    const r = saveText("/etc/hostname", "x", 0);
    expect(r.ok).toBe(false);
  });

  test("a symlink out of the boundary is judged by its target", () => {
    const d = tmp(); const outside = mkdtempSync(join(tmpdir(), "agx-save-out-")); made.push(outside);
    process.env.AGENTGLASS_DISK_ROOTS = d; // the outside folder is not a root
    writeFileSync(join(outside, "t.txt"), "keep");
    symlinkSync(join(outside, "t.txt"), join(d, "link.txt"));
    const r = saveText(join(d, "link.txt"), "pwn", mtimeOf(join(outside, "t.txt")));
    expect(r.ok).toBe(false);
    expect(readFileSync(join(outside, "t.txt"), "utf8")).toBe("keep");
  });

  test("a symlink inside the boundary writes its target", () => {
    const d = tmp(); writeFileSync(join(d, "t.txt"), "a"); symlinkSync(join(d, "t.txt"), join(d, "l.txt"));
    expect(saveText(join(d, "l.txt"), "b", mtimeOf(join(d, "t.txt"))).ok).toBe(true);
    expect(readFileSync(join(d, "t.txt"), "utf8")).toBe("b");
  });

  test("the size cap holds for the new text and for the file already there", () => {
    const d = tmp(); const f = join(d, "big.txt");
    writeFileSync(f, "x");
    expect(saveText(f, "y".repeat(EDIT_CAP + 1), mtimeOf(f)).ok).toBe(false);
    writeFileSync(f, "x".repeat(EDIT_CAP + 1));
    expect(saveText(f, "small", mtimeOf(f)).ok).toBe(false);
    expect(readFileSync(f, "utf8").length).toBe(EDIT_CAP + 1);
  });

  test("a binary and a non-UTF-8 file are left alone", () => {
    const d = tmp(); const b = join(d, "blob.dat"); const l = join(d, "latin.txt");
    writeFileSync(b, Buffer.from([0, 1, 2, 3])); writeFileSync(l, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(saveText(b, "x", mtimeOf(b)).ok).toBe(false);
    expect(saveText(l, "x", mtimeOf(l))).toMatchObject({ ok: false });
    expect(readFileSync(l)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  });

  test("a folder, a missing file and a missing mtime are refused", () => {
    const d = tmp(); mkdirSync(join(d, "sub"));
    expect(saveText(join(d, "sub"), "x", 0).ok).toBe(false);
    expect(saveText(join(d, "nope.txt"), "x", 0).ok).toBe(false);
    writeFileSync(join(d, "a.txt"), "a");
    expect(saveText(join(d, "a.txt"), "x", undefined).ok).toBe(false);
    expect(saveText(join(d, "a.txt"), 5, 1).ok).toBe(false);
  });
});
