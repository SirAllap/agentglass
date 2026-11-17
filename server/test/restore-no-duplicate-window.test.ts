/* A restore pass matches a standing tab by name AND pane path, and never rebuilds a tab whose directory is gone. */
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { windowsToBuild, windowsWithPath, pathIsGone, mergeSkipped, pathGoneDecision, probePath, windowsToRevive, addSkip } from "../src/tmuxrestore.ts";

const w = (name: string, path?: string) => ({ name, panes: path === undefined ? [] : [{ path }] });

describe("windowsToBuild", () => {
  test("same name, same path: not built again", () => {
    expect(windowsToBuild([w("fp-thing", "/work/orbit-fp-thing")], [w("fp-thing", "/work/orbit-fp-thing")])).toEqual([]);
  });
  test("same name, path moved (cd, $HOME): name-only fallback, not built again", () => {
    expect(windowsToBuild([w("fp-thing", "/work/orbit-fp-thing")], [w("fp-thing", "/home/orbit")])).toEqual([]);
  });
  test("name-only fallback uses each live window once", () => {
    const recorded = [w("fp-thing", "/work/a"), w("fp-thing", "/work/b")];
    expect(windowsToBuild(recorded, [w("fp-thing", "/home/orbit")])).toHaveLength(1);
  });
  test("a live window an exact record already used is not taken by name", () => {
    const recorded = [w("fp-thing", "/work/a"), w("fp-thing", "/work/b")];
    expect(windowsToBuild(recorded, [w("fp-thing", "/work/a")]).map((x) => x.panes![0].path)).toEqual(["/work/b"]);
  });
  test("different name: rebuilt", () => {
    const recorded = [w("fp-thing", "/work/a")];
    expect(windowsToBuild(recorded, [w("other", "/work/a")])).toEqual(recorded);
  });
  test("same-named tabs are counted", () => {
    const recorded = [w("fish", "/a"), w("fish", "/a"), w("fp-a", "/b")];
    expect(windowsToBuild(recorded, [w("fish", "/a")]).map((x) => x.name)).toEqual(["fish", "fp-a"]);
  });
});

describe("windowsWithPath", () => {
  test("a window whose path is gone for good is skipped, logged once and reported", () => {
    const lines: string[] = [];
    const skipped: string[] = [];
    const kept = windowsWithPath([w("fp-gone", "/work/orbit-gone"), w("fp-ok", "/work/orbit-ok"), w("bare")],
      (p) => p === "/work/orbit-gone", (l) => lines.push(l), (x) => skipped.push(x.name ?? ""));
    expect(kept.map((x) => x.name)).toEqual(["fp-ok", "bare"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fp-gone");
    expect(lines[0]).toContain("/work/orbit-gone");
    expect(skipped).toEqual(["fp-gone"]);
  });
});

describe("pathIsGone", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-gone-"));
  writeFileSync(join(root, "keep"), "x");
  test("a missing child of a readable parent is gone", () => {
    expect(pathIsGone(join(root, "nope"))).toBe(true);
  });
  test("a present path is not gone", () => {
    expect(pathIsGone(root)).toBe(false);
  });
  test("a missing child of a missing parent is not proof (unmounted drive)", () => {
    expect(pathIsGone(join(root, "mnt", "drive", "nope"))).toBe(false);
  });
  test("a parent that cannot be read is not proof", () => {
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() !== 0) expect(pathIsGone(join(locked, "child"))).toBe(false);
    } finally { chmodSync(locked, 0o700); }
  });
});

describe("pathGoneDecision", () => {
  const ok = { readable: true, empty: false };
  test("ENOENT under a filled parent is gone", () => expect(pathGoneDecision({ stat: "ENOENT", parent: ok })).toBe(true));
  test("ENOENT under an empty parent (unmounted mount point) is not proof", () =>
    expect(pathGoneDecision({ stat: "ENOENT", parent: { readable: true, empty: true } })).toBe(false));
  test("timeout, EACCES, existing: not gone", () => {
    for (const stat of ["timeout", "EACCES", null]) expect(pathGoneDecision({ stat, parent: ok })).toBe(false);
  });
  test("unreadable parent is not proof", () =>
    expect(pathGoneDecision({ stat: "ENOENT", parent: { readable: false, empty: false } })).toBe(false));
  test("probePath: empty parent dir reads as empty", async () => {
    const d = mkdtempSync(join(tmpdir(), "agx-probe-"));
    expect((await probePath(join(d, "nope"))).parent.empty).toBe(true);
    writeFileSync(join(d, "f"), "x");
    expect(pathGoneDecision(await probePath(join(d, "nope")))).toBe(true);
    expect((await probePath(d)).stat).toBeNull();
  });
});

describe("windowsToRevive", () => {
  const DAY = 86_400_000;
  const rec = (path: string, at: number) => ({ session: "orbit", window: w("fp-a", path) as any, at });
  test("revives only records whose path exists again and are inside 7 days", () => {
    const now = 100 * DAY;
    const out = windowsToRevive([rec("/work/a", now - DAY), rec("/work/b", now - DAY), rec("/work/a", now - 8 * DAY)], new Set(["/work/a"]), now);
    expect(out).toHaveLength(1);
    expect(out[0].window.panes![0].path).toBe("/work/a");
  });
  test("a revived record is dropped by the next merge", () => {
    const now = 100 * DAY, r = rec("/work/a", now - DAY);
    expect(mergeSkipped([r], [], now, [r])).toHaveLength(0);
  });
});

describe("addSkip", () => {
  test("same session, name and path is one record", () => {
    const list: any[] = [], x = { session: "orbit", window: w("fp-a", "/work/a") as any, at: 1 };
    addSkip(list, x); addSkip(list, { ...x, at: 2 });
    expect(list).toHaveLength(1);
    addSkip(list, { ...x, session: "other" });
    expect(list).toHaveLength(2);
  });
});

describe("mergeSkipped", () => {
  const DAY = 86_400_000;
  const rec = (at: number) => ({ session: "orbit", window: w("fp-a", "/work/a") as any, at });
  test("keeps a record for 7 days, then lets it go", () => {
    const now = 100 * DAY;
    expect(mergeSkipped([rec(now - 6 * DAY)], [], now)).toHaveLength(1);
    expect(mergeSkipped([rec(now - 8 * DAY)], [], now)).toHaveLength(0);
  });
  test("a window skipped again is one record, not two", () => {
    const now = 100 * DAY;
    expect(mergeSkipped([rec(now - DAY)], [rec(now)], now)).toHaveLength(1);
  });
});
