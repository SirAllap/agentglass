/*
 * Which worktree the agent in a pane is working in.
 *
 * The cases here are the ones that made the previous answer — scanning the
 * terminal for a folder name — wrong on a real machine, kept as tests so the
 * new one cannot regress into them:
 *
 *   * the worktree is named in a tool INPUT, in a `git -C` that the CLI draws
 *     folded as "Ran 3 shell commands";
 *   * a single `git worktree list` names every worktree at once, and it does it
 *     in a tool RESULT — a reader that counted those answers at random;
 *   * the newest mention wins, because a long session moves between worktrees;
 *   * a pane id outlives the agent that was in it, and tmux hands it out again.
 *
 * The transcript is fed as text so all of that is testable without a CLI
 * writing one, which is the same reason paneloc.ts splits its parser out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dirsFromTranscript, ensurePaneAgentTable, noteForSession, notePaneAgent, notePaneFromHook, paneAgentNote, paneDirs, readTail, resetTailCache,
} from "../src/panewt.ts";
import { Database } from "bun:sqlite";

const WT = "/home/dev/code/orbit-WEB-1042";
const REPO = "/home/dev/code/orbit";

/** One transcript line, in the shape the CLI writes. */
const toolUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

const toolResult = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } });

describe("dirsFromTranscript", () => {
  test("finds the worktree in a shell command the screen folds away", () => {
    const t = [
      toolUse("Bash", { command: `git -C ${WT} status --short` }),
    ].join("\n");
    expect(dirsFromTranscript(t)).toContain(WT);
  });

  test("finds it in a file path", () => {
    const t = toolUse("Edit", { file_path: `${WT}/vr/serializers.py` });
    expect(dirsFromTranscript(t)[0]).toBe(`${WT}/vr/serializers.py`);
  });

  test("newest first — a session that moved worktrees answers with the last one", () => {
    const t = [
      toolUse("Bash", { command: `git -C ${REPO}-WEB-900 log` }),
      toolUse("Bash", { command: `git -C ${WT} log` }),
    ].join("\n");
    expect(dirsFromTranscript(t)[0]).toBe(WT);
  });

  test("ignores tool results, where `git worktree list` names all of them at once", () => {
    const every = Array.from({ length: 20 }, (_, i) => `${REPO}-WEB-${i} abc123 [WEB-${i}]`).join("\n");
    const t = [
      toolUse("Bash", { command: `git -C ${WT} status` }),
      toolResult(every),
    ].join("\n");
    // The result is newer than the command and mentions twenty other
    // worktrees. None of them may win.
    expect(dirsFromTranscript(t)[0]).toBe(WT);
    expect(dirsFromTranscript(t).some((d) => d.endsWith("-WEB-7"))).toBe(false);
  });

  test("survives the half line a tail always starts with, and non-JSON", () => {
    const t = [
      `{"type":"assistant","message":{"content":[{"type":"tool_use","inp`,
      "not json at all",
      "",
      toolUse("Bash", { command: `cd ${WT} && bun test` }),
    ].join("\n");
    expect(dirsFromTranscript(t)).toEqual([WT]);
  });

  test("stops at the cap rather than reading a whole session", () => {
    const t = Array.from({ length: 50 }, (_, i) => toolUse("Read", { file_path: `${WT}/f${i}.ts` })).join("\n");
    expect(dirsFromTranscript(t, 5)).toHaveLength(5);
  });

  test("a path stops at the quote or the operator that follows it", () => {
    const t = toolUse("Bash", { command: `cat '${WT}/a.py' && rm ${WT}/b.py` });
    expect(dirsFromTranscript(t)).toEqual([`${WT}/a.py`, `${WT}/b.py`]);
  });
});

describe("readTail", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agx-panewt-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("reads the end of a file, not the start", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "old\n".repeat(1000) + "newest\n");
    expect(readTail(p, 32).endsWith("newest\n")).toBe(true);
  });

  test("a transcript that is not there yet is empty, not a throw", () => {
    expect(readTail(join(dir, "nope.jsonl"))).toBe("");
  });
});

describe("the pane note", () => {
  const PANE = "%9910";

  test("a hook body without a pane, a transcript or a cwd is not stored", () => {
    expect(notePaneFromHook({ session_id: "s", payload: { cwd: REPO } })).toBe(false);
    expect(notePaneFromHook({ session_id: "s", tmux_pane: PANE, payload: { cwd: REPO } })).toBe(false);
    expect(notePaneFromHook({ session_id: "s", tmux_pane: PANE, payload: { transcript_path: "/t.jsonl" } })).toBe(false);
  });

  test("a pane id that is not tmux's spelling is refused", () => {
    expect(notePaneAgent({ pane: "%3; rm -rf /", sessionId: "s", transcriptPath: "/t.jsonl", cwd: REPO })).toBe(false);
    expect(paneAgentNote("%3; rm -rf /")).toBeNull();
  });

  test("one row per pane — the agent in it now replaces the one before", () => {
    notePaneAgent({ pane: PANE, sessionId: "old", transcriptPath: "/old.jsonl", cwd: REPO });
    notePaneAgent({ pane: PANE, sessionId: "new", transcriptPath: "/new.jsonl", cwd: REPO });
    expect(paneAgentNote(PANE)?.session_id).toBe("new");
    expect(paneAgentNote(PANE)?.transcript_path).toBe("/new.jsonl");
  });

  test("the note says which tmux server the pane is on, because a pane id alone is only one server's", () => {
    /* `%2` in the person's own tmux and `%2` on the engine are two panes, and
       the hook fires from both. */
    const P = "%9919", ORBIT = "/tmp/tmux-1000/orbit,4242";
    expect(notePaneFromHook({ session_id: "s1", tmux_pane: P, tmux_server: ORBIT, payload: { transcript_path: "/t.jsonl", cwd: REPO } })).toBe(true);
    expect(paneAgentNote(P, ORBIT)?.server).toBe(ORBIT);
    /* A hook from before this field, or one that sends something else, writes
       a note that names no server — and never files it under the previous
       writer's. */
    expect(notePaneFromHook({ session_id: "s2", tmux_pane: P, payload: { transcript_path: "/t.jsonl", cwd: REPO } })).toBe(true);
    expect(notePaneFromHook({ session_id: "s3", tmux_pane: P, tmux_server: "not a server\n", payload: { transcript_path: "/t.jsonl", cwd: REPO } })).toBe(true);
    expect(paneAgentNote(P, ORBIT)?.session_id, "the server's own note stands").toBe("s1");
    const unnamed = paneAgentNote(P, "/tmp/tmux-1000/default,1");
    expect(unnamed?.server).toBe("");
    expect(unnamed?.session_id).toBe("s3");
  });

  test.skipIf(!Bun.which("python3"))("the hook sends the server out of $TMUX, which it inherits from the pane", async () => {
    let got: Record<string, unknown> = {};
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { got = (await req.json()) as Record<string, unknown>; return new Response("ok"); } });
    try {
      const proc = Bun.spawn(["python3", join(import.meta.dir, "..", "..", "hooks", "send_event.py"), "--server", `http://127.0.0.1:${server.port}`, "--source-app", "orbit"], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), TMUX: "/tmp/tmux-1000/orbit,4242,3", TMUX_PANE: "%7" },
      });
      proc.stdin.write(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s", cwd: REPO, tool_name: "Bash" }));
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(got.tmux_pane).toBe("%7");
      expect(got.tmux_server).toBe("/tmp/tmux-1000/orbit,4242");
    } finally { server.stop(true); }
  });

  test("the same pane id on two tmux servers is two notes, and neither overwrites the other", () => {
    /* The engine's `%2` and the person's own `%2` both fire hooks. Keyed by
       the id alone, whichever fired last took the row, and the engine's agent
       was photographed with no conversation: a shell after the next boot. */
    const P = "%9920", ENGINE = "/tmp/tmux-1000/agentglass,4242", MINE = "/tmp/tmux-1000/default,777";
    notePaneAgent({ pane: P, sessionId: "engine-agent", transcriptPath: "/e.jsonl", cwd: REPO, server: ENGINE, at: 1_000 });
    notePaneAgent({ pane: P, sessionId: "my-agent", transcriptPath: "/m.jsonl", cwd: REPO, server: MINE, at: 2_000 });
    expect(paneAgentNote(P, ENGINE)?.session_id).toBe("engine-agent");
    expect(paneAgentNote(P, MINE)?.session_id).toBe("my-agent");
    /* Asked without a server, the newest — what a row keyed by the id alone
       answered, for the readers that cannot say which server they mean. */
    expect(paneAgentNote(P)?.session_id).toBe("my-agent");
    /* Within one server the agent in the pane now still replaces the one before. */
    notePaneAgent({ pane: P, sessionId: "engine-after-clear", transcriptPath: "/e2.jsonl", cwd: REPO, server: ENGINE, at: 3_000 });
    expect(paneAgentNote(P, ENGINE)?.session_id).toBe("engine-after-clear");
    expect(paneAgentNote(P, MINE)?.session_id).toBe("my-agent");
  });

  test("a server with no note of its own gets one that names no server, never another server's", () => {
    const P = "%9921";
    notePaneAgent({ pane: P, sessionId: "elsewhere", transcriptPath: "/x.jsonl", cwd: REPO, server: "/tmp/tmux-1000/default,777" });
    expect(paneAgentNote(P, "/tmp/tmux-1000/agentglass,5151")).toBeNull();
    /* A hook installed before it named its server: whether that is this
       server's is the caller's question, and `noteIsThisAgents` answers it. */
    notePaneAgent({ pane: P, sessionId: "unnamed", transcriptPath: "/u.jsonl", cwd: REPO });
    expect(paneAgentNote(P, "/tmp/tmux-1000/agentglass,5151")?.session_id).toBe("unnamed");
  });

  test("a session's own note is found by the session, not through a pane id another server may have taken", () => {
    const P = "%9922";
    notePaneAgent({ pane: P, sessionId: "budgeted", transcriptPath: "/b.jsonl", cwd: WT, server: "/tmp/tmux-1000/agentglass,4242", at: 1_000 });
    notePaneAgent({ pane: P, sessionId: "someone-else", transcriptPath: "/s.jsonl", cwd: REPO, server: "/tmp/tmux-1000/default,777", at: 2_000 });
    expect(noteForSession("budgeted")?.cwd).toBe(WT);
    expect(noteForSession("never-seen")).toBeNull();
  });

  test("a table keyed by the pane id alone is rebuilt with the server in the key, and keeps its rows", () => {
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
    d.exec(`ALTER TABLE pane_agent ADD COLUMN server TEXT NOT NULL DEFAULT ''`);
    d.run(`INSERT INTO pane_agent VALUES ('%1', 'kept', '/k.jsonl', '/home/dev/code/orbit', 5, '/tmp/tmux-1000/agentglass,1')`);
    d.run(`INSERT INTO pane_agent VALUES ('%2', 'unnamed', '/u.jsonl', '/home/dev/code/orbit', 6, '')`);
    ensurePaneAgentTable(d);
    const key = d.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_agent)").all().filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(key).toEqual(["pane_id", "server"]);
    expect(d.query("SELECT session_id FROM pane_agent ORDER BY at").all()).toEqual([{ session_id: "kept" }, { session_id: "unnamed" }]);
    /* And now a second server's %1 is a row of its own. */
    d.run(`INSERT INTO pane_agent VALUES ('%1', 'other', '/o.jsonl', '/home/dev/code/orbit', 7, '/tmp/tmux-1000/default,2')`);
    expect(d.query("SELECT COUNT(*) AS n FROM pane_agent WHERE pane_id = '%1'").get()).toEqual({ n: 2 });
    /* Run again on a table already rebuilt: nothing changes. */
    ensurePaneAgentTable(d);
    expect(d.query("SELECT COUNT(*) AS n FROM pane_agent").get()).toEqual({ n: 3 });
    d.close();
  });

  test("a database that never had the table gets it keyed by server and pane", () => {
    const d = new Database(":memory:");
    ensurePaneAgentTable(d);
    const key = d.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_agent)").all().filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(key).toEqual(["pane_id", "server"]);
    d.close();
  });
});

describe("paneDirs", () => {
  let dir = "", transcript = "";
  const PANE = "%9911";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agx-panedirs-"));
    transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, toolUse("Bash", { command: `git -C ${WT} diff` }) + "\n");
    resetTailCache();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("the agent's own directory comes first, and the transcript fills in behind it", () => {
    notePaneAgent({ pane: PANE, sessionId: "s", transcriptPath: transcript, cwd: REPO });
    const { dirs } = paneDirs(PANE, 1, () => [REPO]);
    // The parent repo is where every agent in a fleet stands; the worktree it
    // is actually working in only exists in what it asked for.
    expect(dirs[0]).toBe(REPO);
    expect(dirs).toContain(WT);
  });

  test("an agent started inside the worktree needs no transcript at all", () => {
    const { dirs } = paneDirs("%9912", 1, () => [WT]);
    expect(dirs).toEqual([WT]);
  });

  test("a note from an agent that is no longer in this pane is not believed", () => {
    notePaneAgent({ pane: PANE, sessionId: "s", transcriptPath: transcript, cwd: "/home/dev/code/something-else" });
    // tmux handed %9911 to a different project. The old session's worktree must
    // not come back with it.
    const { dirs } = paneDirs(PANE, 1, () => [REPO]);
    expect(dirs).toEqual([REPO]);
  });

  test("no agent, no note, no answer — and no throw", () => {
    expect(paneDirs("%9913", 1, () => []).dirs).toEqual([]);
  });
});
