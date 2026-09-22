/*
 * A PANE ID IS ONE SERVER'S, AND A REBOOT HANDS THE SAME IDS OUT AGAIN.
 *
 * The note that says which conversation is in which pane was keyed by the
 * pane id alone. Two tmux servers on one machine — the engine the app runs,
 * and the person's own — both have a `%0`, both fire the hooks, and whichever
 * fired last owned the row. The restore already refused a note from another
 * server, so the engine's agent was photographed with the conversation its
 * argv happened to carry, or none:
 *
 *   - a Claude started fresh after a reboot has no `--resume` on its line, so
 *     it was photographed with nothing and came back from the next boot as a
 *     shell — its conversation orphaned;
 *   - a restored Claude that has since `/clear`ed carries the OLD id on its
 *     line, so it was photographed with that and the next boot resumed the
 *     conversation it had left.
 *
 * Driven here on two real servers on private sockets, with a stand-in for the
 * CLI (a shell loop given `claude` as its argv[0], which is what the process
 * walk sees), through a simulated reboot: the engine is killed and started
 * again, and the restored panes come back on the same ids.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/* Read before this file sets them: every test file shares one process. */
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const SOCKET = `agx-reused-${process.pid}`;
/* The person's own tmux: another server, on another socket, same ids. */
const PERSON = `agx-reused-person-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-reused-tmp-${process.pid}`);
const STATE = join(tmpdir(), `agx-reused-state-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = STATE;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");
let wt: typeof import("../src/panewt.ts");

const FIRST = "1a2b3c4d-0000-4000-8000-000000000001";
const SECOND = "1a2b3c4d-0000-4000-8000-000000000002";
const AFTER_CLEAR = "1a2b3c4d-0000-4000-8000-000000000003";
const FRESH = "1a2b3c4d-0000-4000-8000-000000000004";
const STALE = "1a2b3c4d-0000-4000-8000-000000000005";
const THEIRS = ["5e6f7a8b-0000-4000-8000-00000000000a", "5e6f7a8b-0000-4000-8000-00000000000b", "5e6f7a8b-0000-4000-8000-00000000000c"];
const S = `agxreused${process.pid}`;
const CWD = join(tmpdir(), `agx-reused-cwd-${process.pid}`);

const fakeClaude = (...args: string[]) =>
  ["bash", "-c", `exec -a claude /bin/sh -c 'while :; do sleep 1; done' -- "$@"`, "x", ...args];

/* The person's server, run the way the suite runs every tmux: no config, its
   own socket under the private TMUX_TMPDIR, outside any tmux of ours. */
const person = (args: string[]) => {
  const env: Record<string, string | undefined> = { ...process.env, TMUX_TMPDIR: TMPDIR };
  delete env.TMUX;
  const r = Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", PERSON, ...args], { env });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  const conf = await import("../src/tmuxconf.ts");
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
  wt = await import("../src/panewt.ts");
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  person(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  for (const d of [TMPDIR, CWD, STATE]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ }
  }
});

const paneOf = async (win: string) => (await pane.tmux(["display-message", "-p", "-t", `=${S}:${win}`, "#{pane_id}"])).stdout.trim();
const engineServer = async () => (await pane.tmux(["display-message", "-p", "#{socket_path},#{pid}"])).stdout.trim();
const photograph = async () => {
  /* A pane forked a moment ago has not exec'd yet and reads as the tmux
     binary, which the capture leaves out on purpose. */
  await Bun.sleep(300);
  const windows = (await restore.captureLayout())?.sessions.find((s) => s.name === S)?.windows ?? [];
  return (win: string) => windows.find((w) => w.name === win)?.panes[0];
};
/* What a hook in the person's tmux writes for its own pane `id`. */
const theirNote = (id: string, sessionId: string, server: string) =>
  wt.notePaneAgent({ pane: id, sessionId, transcriptPath: "/tmp/theirs.jsonl", cwd: "/home/someone/code/acme", server });

describe("two servers, the same pane ids, and a reboot between two photographs", () => {
  test("each engine pane keeps its own conversation before the reboot and after it", async () => {
    /* ---- Before: two fresh agents on the engine, `%0` and `%1`. ---- */
    expect((await pane.tmux(["new-session", "-d", "-s", S, "-n", "first", "-c", CWD, ...fakeClaude("--model", "opus")])).ok).toBe(true);
    expect((await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "second", "-c", CWD, ...fakeClaude("--model", "opus")])).ok).toBe(true);
    const ids = [await paneOf("first"), await paneOf("second")];
    const before = await engineServer();
    await Bun.sleep(250);
    wt.notePaneAgent({ pane: ids[0]!, sessionId: FIRST, transcriptPath: "/tmp/1.jsonl", cwd: CWD, server: before });
    wt.notePaneAgent({ pane: ids[1]!, sessionId: SECOND, transcriptPath: "/tmp/2.jsonl", cwd: CWD, server: before });

    /* The person's own tmux hands out the same ids, and its hooks fire after. */
    expect(person(["new-session", "-d", "-s", "work", "sleep", "300"]).ok).toBe(true);
    expect(person(["new-window", "-d", "-t", "work:", "sleep", "300"]).ok).toBe(true);
    expect(person(["new-window", "-d", "-t", "work:", "sleep", "300"]).ok).toBe(true);
    const theirIds = person(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim().split("\n");
    const theirServer = person(["display-message", "-p", "#{socket_path},#{pid}"]).stdout.trim();
    expect(theirIds.slice(0, 2), "the two servers share pane ids").toEqual(ids);
    theirIds.forEach((id, i) => theirNote(id, THEIRS[i]!, theirServer));

    let got = await photograph();
    expect(got("first"), "the pane is in the picture").not.toBeUndefined();
    expect(got("first")!.agentSession, "the engine's %0 is its own conversation").toBe(FIRST);
    expect(got("second")!.agentSession).toBe(SECOND);

    /* ---- The reboot: the engine dies, and a new one is started on the
       same socket. The restore runs each conversation's `--resume` in the
       order of the photograph, and tmux hands out the same ids again. ---- */
    await pane.tmux(["kill-server"]);
    await Bun.sleep(200);
    expect((await pane.tmux(["new-session", "-d", "-s", S, "-n", "first", "-c", CWD, ...fakeClaude("--model", "opus", "--resume", FIRST)])).ok).toBe(true);
    expect((await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "second", "-c", CWD, ...fakeClaude("--model", "opus", "--resume", SECOND)])).ok).toBe(true);
    expect((await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "fresh", "-c", CWD, ...fakeClaude("--model", "opus")])).ok).toBe(true);
    const after = await engineServer();
    expect(after, "a new server").not.toBe(before);
    expect([await paneOf("first"), await paneOf("second")], "the restored panes reuse the dead server's ids").toEqual(ids);
    const freshId = await paneOf("fresh");
    expect(theirIds, "and the fresh one an id the person's tmux has too").toContain(freshId);
    await Bun.sleep(250);

    /* A hook the dead server's `%0` fired on its way out, ingested late: it
       names a pane id that is now somebody else's. */
    wt.notePaneAgent({ pane: ids[0]!, sessionId: STALE, transcriptPath: "/tmp/stale.jsonl", cwd: CWD, server: before });
    /* The restored first agent has been `/clear`ed; the fresh one has run a tool. */
    wt.notePaneAgent({ pane: ids[0]!, sessionId: AFTER_CLEAR, transcriptPath: "/tmp/3.jsonl", cwd: CWD, server: after });
    wt.notePaneAgent({ pane: freshId, sessionId: FRESH, transcriptPath: "/tmp/4.jsonl", cwd: CWD, server: after });
    /* And the person's tmux, on the same ids, fires last again. */
    theirIds.forEach((id, i) => theirNote(id, THEIRS[i]!, theirServer));

    got = await photograph();
    expect(got("first"), "the pane is in the picture").not.toBeUndefined();
    expect(got("first")!.agentSession, "the conversation after /clear, not the one on its line").toBe(AFTER_CLEAR);
    expect(got("second")!.agentSession, "no note on this server: the id on its own line").toBe(SECOND);
    expect(got("fresh")!.agentSession, "a fresh agent is not orphaned by another server's hook").toBe(FRESH);
    for (const w of ["first", "second", "fresh"]) {
      expect([...THEIRS, STALE], `${w} never resumes somebody else's conversation`).not.toContain(got(w)!.agentSession);
    }
  }, 30_000);
});
