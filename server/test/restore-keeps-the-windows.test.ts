/*
 * THE SAME INVARIANT, ONE FLOOR DOWN: a WINDOW cannot be lost either.
 *
 * `tmuxrestore-never-shrinks.test.ts` pins the session-level rule, and that
 * rule held. On 2026-09-08 the loss happened anyway, inside a session that was
 * never missing for a moment:
 *
 *   the tmux server died
 *   the engine made the session again — empty, one window
 *   the ten second sweeper photographed one window
 *   the merge saw the session in the live set and let the photograph win whole
 *   six windows of somebody's real work were gone from the file
 *   the restore then read that file, found the session already there, and
 *     skipped it — `has-session` answering a question nobody was asking
 *
 * Every step was correct at its own level. These are the two halves of the
 * fix: a photograph taken before this process has put the desk back cannot
 * shrink a session's window list, and a restore fills in the windows a live
 * session is missing instead of skipping it.
 *
 * And the third: a boot that says "not re-capturing" has to actually stop
 * capturing, which it did not.
 *
 * Against the machine's real tmux, on our own socket and our own state dir.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-wins-test-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-wins-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-wins-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

const SESSION = `ab12cd34-0000-4000-8000-${String(process.pid).padStart(9, "0")}www`;

function windowsRecorded(): string[] {
  const p = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore", "layout.json");
  try {
    const state = JSON.parse(readFileSync(p, "utf8")) as { sessions: { name: string; windows: { name?: string }[] }[] };
    return (state.sessions.find((s) => s.name === SESSION)?.windows ?? []).map((w) => w.name ?? "");
  } catch { return []; }
}

const windowsLive = async (): Promise<string[]> => {
  const r = await pane.tmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_name}"]);
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
};

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
  /* Another file in this process may have run a restore, and the flag is
     per-process by design. This file is about the boot, so it starts there. */
  restore.__resetRestoreSettled();
  await pane.tmux(["new-session", "-d", "-s", SESSION, "-n", "one", "-c", "/tmp"]);
  await pane.tmux(["new-window", "-d", "-t", `=${SESSION}:`, "-n", "two", "-c", "/tmp"]);
  await pane.tmux(["new-window", "-d", "-t", `=${SESSION}:`, "-n", "three", "-c", "/tmp"]);
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

test("three windows go into the photograph", async () => {
  await restore.captureLayout();
  expect(windowsRecorded().sort()).toEqual(["one", "three", "two"]);
});

test("a photograph taken before the restore has run cannot shrink a session", async () => {
  /*
   * THE MORNING, REPRODUCED. Two windows disappear — the tmux server died and
   * came back with one — and the sweeper fires before anything has put the
   * desk back. Before the fix this wrote one window and the other two were
   * gone from the file for good.
   */
  for (const w of ["two", "three"]) await pane.tmux(["kill-window", "-t", `=${SESSION}:${w}`]);
  expect(await windowsLive()).toEqual(["one"]);

  await restore.captureLayout();

  expect(windowsRecorded().sort(), "A WINDOW WAS FORGOTTEN because it was not running")
    .toEqual(["one", "three", "two"]);
});

test("and the restore builds the windows the live session is missing", async () => {
  /*
   * `has-session` said yes, so the old code skipped the session whole. The
   * session was there; five sixths of it was not.
   */
  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(true);
  expect((await windowsLive()).sort(), "the missing windows were never asked for")
    .toEqual(["one", "three", "two"]);
});

test("once the desk has been put back, closing a tab really closes it", async () => {
  /*
   * The other direction, and it matters as much: after the restore has had its
   * go, a shrinking photograph means a person closed something, and bringing
   * it back would be its own bug. `restoreLayout` above set that flag.
   */
  await pane.tmux(["kill-window", "-t", `=${SESSION}:three`]);
  await restore.captureLayout();
  expect(windowsRecorded().sort()).toEqual(["one", "two"]);
});

test("a boot that says it is not re-capturing does not re-capture", async () => {
  /*
   * The message printed on a crash-loop boot promises the saved layout is left
   * untouched, and then the ten second sweeper photographed the crash-loop
   * desk over it. A crash loop is precisely when the live desk is least like
   * the one somebody wants back.
   */
  const before = windowsRecorded();
  restore.noteCrashLoop(6);
  try {
    await pane.tmux(["kill-window", "-t", `=${SESSION}:two`]);
    expect(await restore.captureLayout()).toBeNull();
    expect(windowsRecorded(), "the crash-loop desk was written over the good one").toEqual(before);
  } finally {
    /* Module state, and `bun test` shares one process: leaving this set would
       halt every capture in every file that runs after this one. */
    restore.__clearCrashLoop();
  }
});

test("a restore that blows up leaves the record protected, not settled", async () => {
  /*
   * THE QUESTION THIS ANSWERS, asked in these words: if the restore takes
   * longer than it should, can the photograph every ten seconds overwrite and
   * break it?
   *
   * While the pass is RUNNING, no: `captureLayout` returns null and defers.
   * The hole was on the other side of it. `settled` was set in a `finally`,
   * so a pass that THREW — halfway through rebuilding, file holding six
   * windows, desk holding two — marked the desk as settled anyway, and the
   * next sweep ten seconds later was believed. The moment the record was most
   * worth keeping was the moment it was least protected.
   *
   * A `windows` that is not an array is the cheapest real way to make the pass
   * throw: it is also what a half-written or hand-edited layout.json looks
   * like, so the test is a corrupt-file test as well.
   */
  restore.__resetRestoreSettled();
  const dir = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore");
  const good = windowsRecorded();
  expect(good.length).toBeGreaterThan(0);
  const state = JSON.parse(readFileSync(join(dir, "layout.json"), "utf8")) as { sessions: any[] };
  writeFileSync(join(dir, "layout.json"), JSON.stringify({
    ...state,
    sessions: [{ name: `${SESSION}-broken`, windows: null }, ...state.sessions],
  }));

  /* It answers instead of rejecting: the boot calls this as a floating
     promise, and a throw there skipped the capture that follows it. */
  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(false);

  /* And the desk is NOT settled, so the next photograph still cannot shrink
     the session it could not put back. */
  for (const w of await windowsLive()) {
    if (w !== "one") await pane.tmux(["kill-window", "-t", `=${SESSION}:${w}`]);
  }
  await restore.captureLayout();
  expect(windowsRecorded().sort(), "a broken restore let the next photograph eat the record")
    .toEqual(good.sort());
});
