/*
 * A CONVERSATION IS RESUMED, NEVER REPLAYED.
 *
 * On 2026-09-21 a session the orchestrator had opened as
 * `tmux new-window "exec claude … 'Read the brief and follow it exactly.'"`
 * finished, was closed, and came back at the next restart of the app — the
 * layout file never forgets a session, which is right — and RAN THE BRIEF
 * AGAIN, because the restore replayed the line the pane was born from and the
 * prompt was on it. Each restart had also wrapped that line in one more
 * `sh -c`; it was eight deep by the time somebody read the file.
 *
 * Two rules, both driven here:
 *
 *   - a pane that held a conversation comes back as `claude <flags> --resume
 *     <id>`, whatever its born-with line said;
 *   - the flags are the process's own, minus the prompt — which is known
 *     exactly, because a prompt given on the command line reaches the same
 *     UserPromptSubmit hook as one typed at the box, and the events table
 *     has it.
 *
 * The capture half runs real tmux on its own socket with a stand-in for the
 * CLI: a shell loop given `claude` as its argv[0] (`exec -a`), which is what
 * the process walk sees. The `runArgs` half is pure.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SOCKET = `agx-resume-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-resume-tmp-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-resume-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");
let wt: typeof import("../src/panewt.ts");
let db: typeof import("../src/db.ts");

const ID = "7c1e2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const BRIEF = "Read the file /home/someone/briefs/orbit-1042.md and follow it exactly.";
const S = `agxresume${process.pid}`;
const CWD = join(tmpdir(), `agx-resume-cwd-${process.pid}`);

/** A pane whose process calls itself `claude`: the walk sees argv[0] and
 *  nothing else about it. bash's `exec -a` sets argv[0]; the loop keeps the
 *  process alive; everything after `--` is what a real CLI would have. */
const fakeClaude = (...args: string[]) =>
  ["bash", "-c", `exec -a claude /bin/sh -c 'while :; do sleep 1; done' -- "$@"`, "x", ...args];
/** The same, but it dies with status 1 the moment `stop` exists — a CLI
 *  that crashed mid-conversation. */
const fakeCrashingClaude = (stop: string, ...args: string[]) =>
  ["bash", "-c", `exec -a claude /bin/sh -c 'while [ ! -e ${stop} ]; do sleep 0.2; done; exit 1' -- "$@"`, "x", ...args];

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  const conf = await import("../src/tmuxconf.ts");
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
  wt = await import("../src/panewt.ts");
  db = await import("../src/db.ts");
  /* The engine's config, so a pane whose command failed is kept as the real
     engine keeps it (`remain-on-exit failed`). Written by hand: `ensureConf`
     remembers the content it last wrote, and every test file shares one
     process. */
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  /* Every test file shares one process: a state dir left pointing at a
     directory this file deletes is the next file's problem. */
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
  for (const d of [TMPDIR, CWD, process.env.AGENTGLASS_STATE_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ }
  }
});

const paneOf = async (win: string) => (await pane.tmux(["display-message", "-p", "-t", `=${S}:${win}`, "#{pane_id}"])).stdout.trim();
/* After a beat: a pane forked a moment ago has not exec'd yet and reads as
   the tmux binary itself, which the capture leaves out on purpose. */
const photographed = async (win: string) => {
  await Bun.sleep(250);
  return (await restore.captureLayout())?.sessions.find((s) => s.name === S)?.windows.find((w) => w.name === win)?.panes[0];
};

describe("what the photograph says about a pane holding a conversation", () => {
  test("the id from the hook's note, the flags from the process, and the prompt left out", async () => {
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-n", "brief", "-c", CWD, ...fakeClaude("--model", "fable", "--dangerously-skip-permissions", BRIEF)]);
    expect(mk.ok, mk.stderr).toBe(true);
    const id = await paneOf("brief");
    /* What the hooks would have recorded: the pane's note, and the prompt
       the session was started with, as UserPromptSubmit. */
    expect(wt.notePaneAgent({ pane: id, sessionId: ID, transcriptPath: "/tmp/t.jsonl", cwd: CWD })).toBe(true);
    db.db.run(`INSERT INTO events (source_app, session_id, hook_event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ["orbit", ID, "UserPromptSubmit", JSON.stringify({ prompt: BRIEF }), Date.now()]);

    const got = await photographed("brief");
    expect(got, "the pane is in the picture").toBeDefined();
    expect(got!.agentSession).toBe(ID);
    expect(got!.agentArgs).toContain("--dangerously-skip-permissions");
    expect(got!.agentArgs).toContain("fable");
    expect(got!.agentArgs, "the brief was said once").not.toContain(BRIEF);
    expect(got!.startArgv, "a conversation is not a command line to replay").toBeUndefined();
  }, 20_000);

  test("an agent that has cd'd keeps its conversation: the note is this pane's because it was written while this agent lived", async () => {
    /*
     * The hook's cwd follows the Bash tool's `cd` — one session reported
     * thirteen directories over its life — while the process never moves.
     * Requiring the two to be equal set the note aside after the first
     * `cd server && …`, and the pane came back from a reboot as a shell.
     */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "moved", "-c", CWD, ...fakeClaude("--model", "opus")]);
    const id = await paneOf("moved");
    await Bun.sleep(250);
    expect(wt.notePaneAgent({ pane: id, sessionId: OTHER, transcriptPath: "/tmp/t.jsonl", cwd: join(CWD, "server", "src") })).toBe(true);
    const got = await photographed("moved");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.agentSession, "the conversation of an agent that cd'd").toBe(OTHER);
  }, 20_000);

  test("a note from another tmux server's pane of the same id is somebody else's conversation, however recent", async () => {
    /*
     * Hooks fire from every tmux on the machine, and the note is keyed by the
     * pane id alone: a Claude in the person's own tmux on `%2` writes the
     * note of the engine's `%2`. Accepted by time alone, it would resume that
     * other conversation here at the next boot.
     */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "foreign", "-c", CWD, ...fakeClaude("--model", "opus")]);
    const id = await paneOf("foreign");
    await Bun.sleep(250);
    expect(wt.notePaneAgent({ pane: id, sessionId: OTHER, transcriptPath: "/tmp/t.jsonl", cwd: CWD, server: "/tmp/tmux-1000/default,1" })).toBe(true);
    const got = await photographed("foreign");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.agentSession, "another server's conversation").toBeUndefined();
    /* The same note from THIS server is this pane's, directory or not. */
    const here = (await pane.tmux(["display-message", "-p", "-t", `=${S}:foreign`, "#{socket_path},#{pid}"])).stdout.trim();
    expect(wt.notePaneAgent({ pane: id, sessionId: OTHER, transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", server: here })).toBe(true);
    expect((await photographed("foreign"))!.agentSession).toBe(OTHER);
  }, 20_000);

  test("a note from a previous life of the pane id is somebody else's conversation, not this pane's", async () => {
    /* Pane ids are reused across a reboot; a note written before this
       agent was born — for an agent in another directory — must not resume
       that agent here. */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "stale", "-c", CWD, ...fakeClaude("--model", "opus")]);
    const id = await paneOf("stale");
    wt.notePaneAgent({ pane: id, sessionId: OTHER, transcriptPath: "/tmp/t.jsonl", cwd: "/somewhere/else", at: Date.now() - 60_000 });
    const got = await photographed("stale");
    /* The pane has to be in the picture for the next line to mean anything:
       a `?.` on a pane that was not captured is undefined too. */
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.agentSession).toBeUndefined();
  }, 20_000);

  test("a prompt whose hook has not been ingested yet is still recognised on the next sweep", async () => {
    /*
     * The first photograph of a new pane can run before the CLI has submitted
     * its command-line prompt — in interactive mode that happens after the
     * TUI is up, and on a fresh worktree after the person accepts the trust
     * dialog, which can take minutes. "Not a prompt" was cached for the life
     * of the process, so every later sweep photographed the brief as a flag
     * and the restore ran it again.
     */
    const LATE = "Read the file /home/someone/briefs/orbit-1043.md and follow it exactly.";
    const LATE_ID = "3d4e5f60-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "late", "-c", CWD, ...fakeClaude("--model", "opus", LATE)]);
    const id = await paneOf("late");
    await Bun.sleep(250);
    expect(wt.notePaneAgent({ pane: id, sessionId: LATE_ID, transcriptPath: "/tmp/t.jsonl", cwd: CWD })).toBe(true);
    const early = await photographed("late");
    expect(early, "the pane is in the picture").not.toBeUndefined();
    expect(early!.agentArgs, "no hook yet: the prompt cannot be told from a value, and stays").toContain(LATE);
    db.db.run(`INSERT INTO events (source_app, session_id, hook_event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ["orbit", LATE_ID, "UserPromptSubmit", JSON.stringify({ prompt: LATE }), Date.now()]);
    const later = await photographed("late");
    expect(later!.agentArgs, "the hook arrived: the brief is out of the flags").not.toContain(LATE);
    expect(later!.agentArgs).toContain("opus");
  }, 20_000);

  test("a flag's value that somebody once typed as a prompt, in another session, before this agent existed, is still a value", async () => {
    /*
     * The prompt question is asked of every argument that is not a flag,
     * the value after `--model` included. Asked of every session ever, a
     * prompt as short as "opus" — prompts of one word are in the table —
     * dropped the value, and the resume line became `claude --model --resume
     * <id>`: the flag eats the id, and the id becomes a positional prompt.
     */
    const STRAY = "8e9f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b";
    db.db.run(`INSERT INTO events (source_app, session_id, hook_event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ["orbit", STRAY, "UserPromptSubmit", JSON.stringify({ prompt: "opus" }), Date.now() - 3_600_000]);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "value", "-c", CWD, ...fakeClaude("--model", "opus")]);
    const got = await photographed("value");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    const args = got!.agentArgs ?? [];
    expect(args[args.indexOf("--model") + 1], "the value after --model").toBe("opus");
  }, 20_000);

  test("a Claude that crashed comes back on its conversation, flags and all", async () => {
    /*
     * The engine keeps a pane whose command failed, with its status on it;
     * the photograph of that pane used to be a shell, so after a reboot a
     * crashed agent's conversation was gone with it. The pane was photographed
     * alive, on this same engine, moments before: that photograph has the id
     * and the flags, and is what the dead pane comes back as.
     */
    const CRASH = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    const stop = join(CWD, "stop-crash");
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "crash", "-c", CWD, ...fakeCrashingClaude(stop, "--model", "opus", "--dangerously-skip-permissions")]);
    const id = await paneOf("crash");
    await Bun.sleep(250);
    expect(wt.notePaneAgent({ pane: id, sessionId: CRASH, transcriptPath: "/tmp/t.jsonl", cwd: CWD })).toBe(true);
    const alive = await photographed("crash");
    expect(alive?.agentSession, "photographed alive first").toBe(CRASH);
    writeFileSync(stop, "");
    for (let i = 0; i < 40; i++) {
      const d = await pane.tmux(["display-message", "-p", "-t", `=${S}:crash`, "#{pane_dead}"]);
      if (d.stdout.trim() === "1") break;
      await Bun.sleep(100);
    }
    const dead = await photographed("crash");
    expect(dead, "the pane is in the picture").not.toBeUndefined();
    expect(dead!.dead).toBe(true);
    expect(dead!.agentSession, "the conversation of the agent that died here").toBe(CRASH);
    expect(dead!.agentArgs).toContain("--dangerously-skip-permissions");
    expect(dead!.startCommand, "never the born-with line: that is the failure again").toBe("");
    expect(restore.runArgs("all", dead, "/opt/agentglass/bin/claude")).toEqual(["/opt/agentglass/bin/claude", ...dead!.agentArgs!, "--resume", CRASH]);
  }, 20_000);

  test("and one that died before it was ever photographed comes back by its note, without flags", async () => {
    const EARLY = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";
    const stop = join(CWD, "stop-early");
    writeFileSync(stop, "");
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "early", "-c", CWD, ...fakeCrashingClaude(stop, "--model", "opus")]);
    const id = await paneOf("early");
    expect(wt.notePaneAgent({ pane: id, sessionId: EARLY, transcriptPath: "/tmp/t.jsonl", cwd: CWD })).toBe(true);
    const got = await photographed("early");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.dead).toBe(true);
    expect(got!.agentSession).toBe(EARLY);
    expect(got!.agentArgs).toBeUndefined();
  }, 20_000);

  test("a dead pane with another server's note, or one not born as the CLI, is a shell", async () => {
    const FOREIGN = "8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a";
    const stop = join(CWD, "stop-foreign");
    writeFileSync(stop, "");
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "dforeign", "-c", CWD, ...fakeCrashingClaude(stop, "--model", "opus")]);
    const id = await paneOf("dforeign");
    wt.notePaneAgent({ pane: id, sessionId: FOREIGN, transcriptPath: "/tmp/t.jsonl", cwd: CWD, server: "/tmp/tmux-1000/default,1" });
    const got = await photographed("dforeign");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.dead).toBe(true);
    expect(got!.agentSession, "the person's own tmux wrote that note").toBeUndefined();

    /* Born as a wrapper that exits 1; a Claude ran in it once, on this server. */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "wrapper", "-c", CWD, "sh", "-c", "sleep 0.3; exit 1"]);
    const wid = await paneOf("wrapper");
    const here = (await pane.tmux(["display-message", "-p", "-t", `=${S}:wrapper`, "#{socket_path},#{pid}"])).stdout.trim();
    wt.notePaneAgent({ pane: wid, sessionId: FOREIGN, transcriptPath: "/tmp/t.jsonl", cwd: CWD, server: here });
    await Bun.sleep(600);
    const wrapped = await photographed("wrapper");
    expect(wrapped, "the pane is in the picture").not.toBeUndefined();
    expect(wrapped!.dead).toBe(true);
    expect(wrapped!.agentSession, "a wrapper's corpse is not a conversation").toBeUndefined();
  }, 20_000);

  test("a dead pane with a note from a previous life of its id is a shell", async () => {
    const OLD = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    const stop = join(CWD, "stop-old");
    writeFileSync(stop, "");
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "old", "-c", CWD, ...fakeCrashingClaude(stop, "--model", "opus")]);
    const id = await paneOf("old");
    /* Written before this engine existed. */
    expect(wt.notePaneAgent({ pane: id, sessionId: OLD, transcriptPath: "/tmp/t.jsonl", cwd: CWD, at: Date.now() - 3_600_000 })).toBe(true);
    const got = await photographed("old");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.dead).toBe(true);
    expect(got!.agentSession).toBeUndefined();
  }, 20_000);

  test("a pane that was itself restored carries its id on its own line", async () => {
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "second", "-c", CWD, ...fakeClaude("--dangerously-skip-permissions", "--resume", OTHER)]);
    const got = await photographed("second");
    expect(got, "the pane is in the picture").not.toBeUndefined();
    expect(got!.agentSession).toBe(OTHER);
    expect(got?.agentArgs).toContain("--dangerously-skip-permissions");
    expect(got?.agentArgs, "the id is re-supplied, never carried in the flags").not.toContain(OTHER);
    expect(got?.agentArgs).not.toContain("--resume");
  }, 20_000);
});

describe("what the pane is told to run", () => {
  const BIN = "/opt/agentglass/bin/claude";
  test("a conversation is resumed by its id, whatever line the pane was born from", () => {
    const born = `"exec claude --model fable --dangerously-skip-permissions '${BRIEF}'"`;
    expect(restore.runArgs("all", { id: "%1", index: 0, active: true, command: "claude", path: "/tmp", startCommand: born, agentSession: ID, agentArgs: ["--model", "fable", "--dangerously-skip-permissions"] }, BIN))
      .toEqual([BIN, "--model", "fable", "--dangerously-skip-permissions", "--resume", ID]);
  });

  test("and with no CLI to resume it, the pane is a shell — never the born-with line", () => {
    expect(restore.runArgs("all", { id: "%1", index: 0, active: true, command: "claude", path: "/tmp", startCommand: "claude 'do it again'", agentSession: ID }, null))
      .toEqual([]);
  });

  test("the flags are the process's own minus the prompt, and only the prompt", () => {
    const argv = ["claude", "--model", "fable", "--disallowedTools", "Bash(git push:*) Bash(gh pr create:*)", "--dangerously-skip-permissions", BRIEF];
    expect(restore.agentArgsOf(argv, (t) => t === BRIEF))
      .toEqual(["--model", "fable", "--disallowedTools", "Bash(git push:*) Bash(gh pr create:*)", "--dangerously-skip-permissions"]);
    /* A value with spaces is not a prompt because it has spaces. */
    expect(restore.agentArgsOf(argv)).toContain(BRIEF);
  });

  test("the events table says which argument was a prompt, exactly", () => {
    db.db.run(`INSERT INTO events (source_app, session_id, hook_event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ["orbit", OTHER, "UserPromptSubmit", JSON.stringify({ prompt: "fix the failing test" }), Date.now()]);
    expect(db.wasPromptOf(OTHER, "fix the failing test")).toBe(true);
    expect(db.wasPromptOf(OTHER, "fable")).toBe(false);
    expect(db.wasPromptOf(ID, "fix the failing test"), "another session's prompt is not this one's").toBe(false);
    expect(db.wasPromptOf("", "fix the failing test")).toBe(false);
  });
});
