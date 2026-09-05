/*
 * THE INVARIANT: a tmux session cannot be lost by anything this app does.
 *
 * On 2026-08-25 the machine rebooted and Electron crash-looped — six launches
 * in twenty-three minutes, one a hard `Failed to shutdown`. Every tmux session
 * from the previous day was gone afterwards except one. The tmux daemon never
 * died: it is a separate process and it survived all six.
 *
 * What died was the bookkeeping. `captureLayout()` photographed whichever
 * sessions were alive at that instant and OVERWROTE layout.json with that set.
 * Mid-crash-loop, that set was tiny. The next boot read the smaller file, saw
 * those sessions already existed, restored nothing further, and photographed
 * the small set again. State could only shrink.
 *
 * These tests are the invariant, not the implementation: whatever the means,
 * a capture must never end with fewer sessions recorded than it started with,
 * unless somebody explicitly closed one.
 *
 * Against the machine's real tmux, on our own socket and our own state dir.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-shrink-test-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-shrink-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-shrink-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

const NAME = (n: string) => `ab12cd34-0000-4000-8000-${String(process.pid).padStart(9, "0")}${n}`;
const LIVE = NAME("aaa");
const GONE = NAME("bbb");

function layout(): { sessions: { name: string }[] } | null {
  const p = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore", "layout.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

test("a session that is not alive right now is NOT forgotten", async () => {
  /*
   * THE EXACT MORNING, reproduced: the file lists two sessions and only one is
   * alive. Before the fix this wrote one and the other was gone for good.
   */
  const mk = await pane.tmux(["new-session", "-d", "-s", LIVE, "-c", "/tmp"]);
  expect(mk.ok).toBe(true);
  await restore.captureLayout();

  // Hand-write a layout that also remembers a session which is not running —
  // the state a crash-loop leaves behind.
  const dir = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore");
  mkdirSync(dir, { recursive: true });
  const before = layout()!;
  writeFileSync(join(dir, "layout.json"), JSON.stringify({
    capturedAt: Date.now(),
    sessions: [...before.sessions, { name: GONE, windows: [], lastSeen: Date.now() }],
  }));
  expect(layout()!.sessions.length).toBe(2);

  await restore.captureLayout();

  const after = layout()!;
  const names = after.sessions.map((s) => s.name);
  expect(names, "the live one was dropped").toContain(LIVE);
  expect(names, "A SESSION WAS FORGOTTEN because it was not running").toContain(GONE);
});

test("and repeated captures never shrink it, however many times they run", async () => {
  /* Six launches in twenty minutes is what happened. Ten here, for margin. */
  const start = layout()!.sessions.length;
  for (let i = 0; i < 10; i++) await restore.captureLayout();
  expect(layout()!.sessions.length, "capture shrank the recorded state").toBeGreaterThanOrEqual(start);
});

test("only an explicit close removes an entry", async () => {
  /*
   * The one subtraction in the file, and it takes a deliberate call. "It is
   * not in the live list" was precisely the inference that lost a day.
   */
  expect(layout()!.sessions.map((s) => s.name)).toContain(GONE);
  restore.forgetSession(GONE);
  expect(layout()!.sessions.map((s) => s.name), "an explicit close did not remove it").not.toContain(GONE);
  // And it stays gone: a later capture must not resurrect it from a stale read.
  await restore.captureLayout();
  expect(layout()!.sessions.map((s) => s.name)).not.toContain(GONE);
});

test("the file is written atomically, so a crash mid-write cannot truncate it", () => {
  /*
   * A truncated layout.json parses as nothing at all, which is the same total
   * loss by a different route. `rename` inside one directory is atomic: a
   * reader sees the whole old file or the whole new one, never half of either.
   */
  const src = readFileSync(new URL("../src/tmuxrestore.ts", import.meta.url), "utf8");
  const writes = src.split("\n").filter((l) => l.includes("writeFileSync(") && l.includes("layoutPath()"));
  expect(writes, "layout.json is written straight, without a rename").toEqual([]);
  expect(src).toContain("renameSync(tmp, layoutPath())");
});

test("a capture asked for mid-restore is deferred, not taken", () => {
  /*
   * `restoreLayout` rebuilds sessions one subprocess at a time; in "all" mode
   * that is seconds. A capture firing in the middle photographs a half-built
   * desk. The merge makes that survivable — this makes it not happen.
   */
  const src = readFileSync(new URL("../src/tmuxrestore.ts", import.meta.url), "utf8");
  expect(src).toContain("if (restoring) { captureWanted = true; return null; }");
  expect(src, "nothing runs the deferred capture when the restore ends").toContain("if (captureWanted)");
});

test("boot restores BEFORE it captures", () => {
  /*
   * The order was the bug. Capturing first photographs a desk that is by
   * definition not back yet, and that photograph became the new truth.
   */
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const at = idx.indexOf("RESTORE FIRST, CAPTURE AFTER");
  expect(at, "the boot order note is gone — check what replaced it").toBeGreaterThan(-1);
  const body = idx.slice(at, at + 2500);
  expect(body).toContain("restoreLayout().then(() => captureLayout())");
});

test("a crash loop declines to touch the layout at all, and says so", () => {
  /*
   * Six launches in twenty-three minutes. With the merge in place a loop can
   * no longer destroy anything, but running the cycle is pointless churn and a
   * person deserves to be told rather than working it out from what is
   * missing.
   */
  const now = Date.now();
  let looping = false;
  for (let i = 0; i < 6; i++) looping = restore.noteLaunch(now + i * 1000).looping;
  expect(looping, "six launches in six seconds did not read as a loop").toBe(true);

  // And a single launch long afterwards does not.
  expect(restore.noteLaunch(now + 60 * 60 * 1000).looping).toBe(false);
});

/**
 * A phone mirror is never captured, kept, or rebuilt — and this rule exists
 * because of the guarantee above, not in spite of it.
 *
 * "Nothing is ever forgotten" worked, and it applied just as faithfully to nine
 * `agx-phone-…` mirrors a phone had left behind: captured, kept, and rebuilt on
 * EVERY boot, each with its own copy of four windows running `claude --resume`.
 * Nine hours from a cold start that was 525 MCP processes and 13 GB of memory,
 * with swap at 27 of 31 GB.
 *
 * Killing them did nothing: the next install brought all nine back BY NAME
 * within seconds, which is what makes this a restore-side bug rather than a
 * tmux one. A mirror belongs to a phone that was attached at that instant, so
 * rebuilding one is making a copy of a desk for a screen that is not there.
 */
const MIRROR = `agx-phone-1-${String(process.pid).slice(-5)}z`;

test("a phone mirror is never written into the layout", async () => {
  const mk = await pane.tmux(["new-session", "-d", "-s", MIRROR, "-c", "/tmp"]);
  expect(mk.ok).toBe(true);

  await restore.captureLayout();

  const names = layout()!.sessions.map((s) => s.name);
  expect(names, "A MIRROR IN THE FILE IS A MIRROR THAT COMES BACK ON EVERY BOOT").not.toContain(MIRROR);
  // …and the real session beside it is still there, which is the whole point.
  expect(names).toContain(LIVE);
});

test("a layout that ALREADY names one stops carrying it forward", async () => {
  const dir = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore");
  const before = layout()!;
  writeFileSync(join(dir, "layout.json"), JSON.stringify({
    capturedAt: Date.now(),
    sessions: [...before.sessions, { name: "agx-phone-99-oldrec", windows: [], lastSeen: Date.now() }],
  }));
  expect(layout()!.sessions.map((s) => s.name)).toContain("agx-phone-99-oldrec");

  await restore.captureLayout();

  const names = layout()!.sessions.map((s) => s.name);
  expect(names, "every file written before this rule still names nine of them").not.toContain("agx-phone-99-oldrec");
  /* And everything else the file already held is still held — the narrowing is
     to mirrors only, and the guarantee above is untouched. */
  for (const kept of before.sessions.map((x) => x.name)) {
    expect(names, `${kept} was dropped along with the mirror`).toContain(kept);
  }
});

test("a name that only LOOKS like a mirror is a session like any other", async () => {
  /* The regex is the contract, the same one `isPhoneSession` uses. A session
     the user happened to call this is theirs, and losing it would be the very
     failure this file exists to prevent. */
  const decoy = `agx-phone-notdigits-${String(process.pid).slice(-4)}`;
  const mk = await pane.tmux(["new-session", "-d", "-s", decoy, "-c", "/tmp"]);
  expect(mk.ok).toBe(true);

  await restore.captureLayout();

  expect(layout()!.sessions.map((s) => s.name), "a heuristic on the prefix would eat a real session").toContain(decoy);
  await pane.tmux(["kill-session", "-t", `=${decoy}`]);
});
