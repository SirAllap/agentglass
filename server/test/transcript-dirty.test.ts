import { describe, expect, test } from "bun:test";
import { DIRTY_CHUNK, judgeWatchEvent, planTick, takeNewest } from "../src/transcriptDirty.ts";

// Shapes taken from a real projects tree, names invented.
const proj = "/home/ann/.claude/projects/-home-ann-code-orbit";

describe("judgeWatchEvent", () => {
  test("a transcript append is a file", () => {
    expect(judgeWatchEvent(proj, "6f1c2a10-0000-4000-8000-00000000abcd.jsonl")).toEqual({
      kind: "file",
      path: `${proj}/6f1c2a10-0000-4000-8000-00000000abcd.jsonl`,
    });
  });
  test("a subagent transcript is a file under its own directory", () => {
    const d = `${proj}/6f1c2a10-0000-4000-8000-00000000abcd/subagents`;
    expect(judgeWatchEvent(d, "agent-a1b2.jsonl")).toEqual({ kind: "file", path: `${d}/agent-a1b2.jsonl` });
  });
  test("a new session directory is a directory to descend into", () => {
    expect(judgeWatchEvent(proj, "6f1c2a10-0000-4000-8000-00000000abcd")).toEqual({
      kind: "dir",
      path: `${proj}/6f1c2a10-0000-4000-8000-00000000abcd`,
    });
  });
  test("a tool-result text file is not ours", () => {
    expect(judgeWatchEvent(`${proj}/s/tool-results`, "toolu_01.txt").kind).toBe("ignore");
  });
  test("an event with no name rescans the directory", () => {
    expect(judgeWatchEvent(proj, null)).toEqual({ kind: "dir", path: proj });
    expect(judgeWatchEvent(proj, "")).toEqual({ kind: "dir", path: proj });
  });
});

describe("planTick", () => {
  const base = { dirty: 0, dirDirty: 0, now: 1_000_000, lastReconcile: 1_000_000, reconcileMs: 300_000, inUse: true };
  test("nothing dirty and no reconcile due costs nothing", () => {
    expect(planTick(base)).toBe("idle");
  });
  test("dirty files are read", () => {
    expect(planTick({ ...base, dirty: 2 })).toBe("dirty");
    expect(planTick({ ...base, dirDirty: 1 })).toBe("dirty");
  });
  test("a reconcile falls due only while the app is in use", () => {
    const due = { ...base, now: base.lastReconcile + 300_000 };
    expect(planTick(due)).toBe("reconcile");
    expect(planTick({ ...due, inUse: false })).toBe("idle");
    expect(planTick({ ...due, inUse: false, dirty: 1 })).toBe("dirty");
  });
});

/*
 * A tree of 200,000 transcripts dropped in at once: the first sweep was handed
 * everything the watch had marked so far and read it to the end, so the one
 * transcript written afterwards waited behind tens of thousands of files and
 * the server test that waits for it gave up at 120 s.
 */
describe("takeNewest", () => {
  const set = (n: number) => new Set(Array.from({ length: n }, (_, i) => `${proj}/s-${i}.jsonl`));

  test("a small set is taken whole, the last mark first", () => {
    const dirty = set(3);
    expect(takeNewest(dirty, 10)).toEqual([`${proj}/s-2.jsonl`, `${proj}/s-1.jsonl`, `${proj}/s-0.jsonl`]);
    expect(dirty.size).toBe(0);
  });

  test("a bulk is taken a chunk at a time and nothing is dropped", () => {
    const dirty = set(5);
    expect(takeNewest(dirty, 2)).toEqual([`${proj}/s-4.jsonl`, `${proj}/s-3.jsonl`]);
    expect([...dirty]).toEqual([`${proj}/s-0.jsonl`, `${proj}/s-1.jsonl`, `${proj}/s-2.jsonl`]);
    expect(takeNewest(dirty, 2)).toEqual([`${proj}/s-2.jsonl`, `${proj}/s-1.jsonl`]);
    expect(takeNewest(dirty, 2)).toEqual([`${proj}/s-0.jsonl`]);
    expect(takeNewest(dirty, 2)).toEqual([]);
  });

  test("a transcript marked while a bulk waits is in the next chunk", () => {
    const dirty = set(DIRTY_CHUNK * 3);
    takeNewest(dirty, DIRTY_CHUNK);
    // The watcher's mark: out and in again, so it is the last one.
    const live = `${proj}/s-7.jsonl`;
    dirty.delete(live);
    dirty.add(live);
    expect(takeNewest(dirty, DIRTY_CHUNK)[0]).toBe(live);
    expect(DIRTY_CHUNK).toBeLessThanOrEqual(5000);
  });
});

const scanner = await Bun.file(new URL("../src/transcripts.ts", import.meta.url)).text();

describe("the watcher", () => {
  const fn = (head: string) => {
    const at = scanner.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    // To the method's own closing brace, comments out.
    return scanner.slice(at, scanner.indexOf("\n  },\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  };

  test("a directory is watched before it is listed, and its files are marked even when the watch is refused", () => {
    const body = fn("async syncDir(dir: string, markNew = true): Promise<void> {");
    const watched = body.indexOf("const watched = this.watchDir(dir);");
    expect(watched).toBeGreaterThan(-1);
    expect(body.indexOf("await readdir(dir")).toBeGreaterThan(watched);
    expect(body).toContain("(fresh || !watched)");
    expect(body).toContain("if (!watched) this.ok = false;");
  });

  test("a mark moves the transcript to the end of the set", () => {
    const body = fn("mark(path: string): void {");
    expect(body.indexOf("this.dirty.delete(path);")).toBeGreaterThan(-1);
    expect(body.indexOf("this.dirty.add(path);")).toBeGreaterThan(body.indexOf("this.dirty.delete(path);"));
  });

  test("a sweep takes a chunk of the dirty set, and a watch that failed starts the poll", () => {
    const at = scanner.indexOf("const tick = async () => {");
    expect(at).toBeGreaterThan(-1);
    const body = scanner.slice(at, scanner.indexOf("\n      };\n", at));
    expect(body).toContain("takeNewest(watcher.dirty, DIRTY_CHUNK)");
    expect(body).toContain("if (!watcher.ok) poll();");
  });
});

// The watcher itself, on a fixture tree shaped like a real projects folder.
describe("transcript watcher handles", () => {
  test("no handle per file, none under tool-results or memory, an append marks only that file", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, readlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "agx-watch-"));
    const prevEnv = process.env.AGENTGLASS_PROJECTS_DIR;
    process.env.AGENTGLASS_PROJECTS_DIR = root;
    const { __watcherForTest: w } = await import("../src/transcripts.ts");
    try {
      const proj = join(root, "-home-ann-code-orbit");
      const sess = join(proj, "6f1c2a10-0000-4000-8000-00000000abcd");
      mkdirSync(join(sess, "tool-results"), { recursive: true });
      mkdirSync(join(sess, "subagents"), { recursive: true });
      mkdirSync(join(proj, "memory"), { recursive: true });
      for (let i = 0; i < 40; i++) writeFileSync(join(proj, `s${i}.jsonl`), '{"a":1}\n');
      writeFileSync(join(sess, "subagents", "agent-a1.jsonl"), '{"a":1}\n');
      writeFileSync(join(sess, "tool-results", "t.txt"), "x");
      await w.attach();
      const watched = [...w.dirs.keys()].sort();
      expect(watched).toEqual([root, proj, sess, join(sess, "subagents")].sort());
      const held = readdirSync("/proc/self/fd").filter((fd) => {
        try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(root); } catch { return false; }
      });
      expect(held.length).toBe(0);
      w.dirty.clear();
      appendFileSync(join(proj, "s3.jsonl"), '{"b":2}\n');
      appendFileSync(join(sess, "tool-results", "t.txt"), "y");
      for (let i = 0; i < 50 && w.dirty.size === 0; i++) await Bun.sleep(40);
      await Bun.sleep(100);
      expect([...w.dirty]).toEqual([join(proj, "s3.jsonl")]);
    } finally {
      if (prevEnv === undefined) delete process.env.AGENTGLASS_PROJECTS_DIR; else process.env.AGENTGLASS_PROJECTS_DIR = prevEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("judgeWatchEvent skips non-transcript dirs", () => {
  test("tool-results and memory are ignored", () => {
    const p = "/x/projects/-home-ann-code-orbit";
    expect(judgeWatchEvent(p, "memory").kind).toBe("ignore");
    expect(judgeWatchEvent(`${p}/s`, "tool-results").kind).toBe("ignore");
  });
});

// Review fixes: overflow, no-inotify fallback, rename releases the kernel watch.
async function fixtureTree() {
  const { mkdirSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const base = join(process.cwd(), ".vt");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "agx-watch-"));
  const proj = join(root, "-home-ann-code-orbit");
  const sess = join(proj, "6f1c2a10-0000-4000-8000-00000000abcd");
  mkdirSync(join(sess, "tool-results"), { recursive: true });
  mkdirSync(join(sess, "subagents"), { recursive: true });
  mkdirSync(join(proj, "memory"), { recursive: true });
  for (let i = 0; i < 5; i++) writeFileSync(join(proj, `s${i}.jsonl`), '{"a":1}\n');
  return { root, proj, sess, join };
}
async function withWatcher(fn: (w: any, t: Awaited<ReturnType<typeof fixtureTree>>, m: any) => Promise<void>) {
  const { rmSync } = await import("node:fs");
  const t = await fixtureTree();
  const prev = process.env.AGENTGLASS_PROJECTS_DIR;
  process.env.AGENTGLASS_PROJECTS_DIR = t.root;
  const m = await import("../src/transcripts.ts");
  const w: any = m.__watcherForTest;
  const orig = w.openWatcher;
  try { await fn(w, t, m); } finally {
    for (const d of w.dirs.values()) { try { d.close(); } catch {} }
    try { w.ino?.close(); } catch {}
    w.ino = null; w.noIno = false; w.openWatcher = orig; w.dirs.clear(); w.wds.clear(); w.dirty.clear(); w.dirDirty.clear();
    m.__lastMtimeForTest.clear();
    if (prev === undefined) delete process.env.AGENTGLASS_PROJECTS_DIR; else process.env.AGENTGLASS_PROJECTS_DIR = prev;
    rmSync(t.root, { recursive: true, force: true });
  }
}

describe("watcher review fixes", () => {
  test("queue overflow marks every known transcript dirty, not only the roots", async () => {
    await withWatcher(async (w, t, m) => {
      const files = [0, 1, 2].map((i) => t.join(t.proj, `s${i}.jsonl`));
      m.__lastMtimeForTest.clear();   // the process is shared: transcripts the files before this one registered are "known" too
      for (const f of files) m.__lastMtimeForTest.set(f, 1);
      w.dirty.clear(); w.dirDirty.clear();
      w.onEvent({ wd: -1, mask: 0x4000, name: "" });
      expect([...w.dirty].sort()).toEqual(files.sort());
      expect(w.dirDirty.has(t.root)).toBe(true);
    });
  });

  test("no inotify: fs.watch per directory, still skips tool-results and memory, append marks the file", async () => {
    await withWatcher(async (w, t) => {
      const { appendFileSync } = await import("node:fs");
      w.openWatcher = () => null;
      await w.attach();
      expect(w.ok).toBe(true);
      expect(w.ino).toBeNull();
      expect([...w.dirs.keys()].sort()).toEqual([t.root, t.proj, t.sess, t.join(t.sess, "subagents")].sort());
      w.dirty.clear();
      appendFileSync(t.join(t.proj, "s2.jsonl"), '{"b":2}\n');
      for (let i = 0; i < 50 && w.dirty.size === 0; i++) await Bun.sleep(40);
      expect([...w.dirty]).toEqual([t.join(t.proj, "s2.jsonl")]);
    });
  });

  test("no inotify: a deleted folder recreated under the same name is watched again", async () => {
    await withWatcher(async (w, t) => {
      const { rmSync, mkdirSync, writeFileSync } = await import("node:fs");
      w.openWatcher = () => null;
      await w.attach();
      const gone = t.join(t.proj, "sess-b");
      mkdirSync(gone, { recursive: true }); writeFileSync(t.join(gone, "old.jsonl"), "{}\n");
      await w.syncDir(t.proj);
      expect(w.dirs.has(gone)).toBe(true);
      rmSync(gone, { recursive: true, force: true });
      for (let i = 0; i < 50 && w.dirs.has(gone); i++) await Bun.sleep(40);
      expect(w.dirs.has(gone)).toBe(false);
      mkdirSync(gone, { recursive: true });
      const f = t.join(gone, "n.jsonl");
      writeFileSync(f, '{"a":1}\n');
      w.dirty.clear();
      // The parent's event names the new folder; the sweep that follows must watch it and mark its files,
      // without waiting for the reconcile.
      await w.syncDir(gone);
      expect(w.dirs.has(gone)).toBe(true);
      expect([...w.dirty]).toContain(f);
    });
  });

  test("a renamed directory gives its kernel watch back", async () => {
    await withWatcher(async (w, t) => {
      const { renameSync, readdirSync, readlinkSync, readFileSync } = await import("node:fs");
      await w.attach();
      // Other inotify instances may be open in this process: this one holds the root.
      const wdLines = (f: string) => readFileSync(`/proc/self/fdinfo/${f}`, "utf8").split("\n").filter((l) => l.startsWith("inotify wd:"));
      const fd = readdirSync("/proc/self/fd").find((f) => {
        try { return readlinkSync(`/proc/self/fd/${f}`) === "anon_inode:inotify" && wdLines(f).length === w.wds.size; } catch { return false; }
      });
      expect(fd).toBeDefined();
      const count = () => wdLines(fd as string).length;
      const before = count();
      renameSync(t.sess, t.join(t.proj, "moved-away"));
      for (let i = 0; i < 60 && w.dirs.has(t.sess); i++) await Bun.sleep(50);
      expect(w.dirs.has(t.sess)).toBe(false);
      // sess and its subagents child stay watched by the kernel unless removed;
      // only sess itself got IN_MOVE_SELF, so exactly one watch is released.
      expect(count()).toBe(before - 1);
    });
  });
});
