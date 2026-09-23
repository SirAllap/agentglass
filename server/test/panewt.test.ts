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
  dirsFromTranscript, ensurePaneNoteTable, noteForSession, notePaneAgent, notePaneFromHook, paneAgentNote, paneDirs, paneHeldSessions, readTail, resetTailCache,
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
    expect(noteForSession("s1")?.server, "the server's own note stands").toBe(ORBIT);
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

  test("a newer note that names no server is not hidden behind an older one of this server's", () => {
    /* An agent started with `env -u TMUX` keeps TMUX_PANE: its hooks name the
       pane and no server. Ranked below this server's older row, the newer
       note was never read, and the older one failed the time test. */
    const P = "%9923", HERE = "/tmp/tmux-1000/agentglass,4242";
    notePaneAgent({ pane: P, sessionId: "before", transcriptPath: "/b.jsonl", cwd: REPO, server: HERE, at: 1_000 });
    notePaneAgent({ pane: P, sessionId: "after", transcriptPath: "/a.jsonl", cwd: REPO, at: 2_000 });
    expect(paneAgentNote(P, HERE)?.session_id).toBe("after");
  });

  test("a session's own note is found by the session, not through a pane id another server may have taken", () => {
    const P = "%9922";
    notePaneAgent({ pane: P, sessionId: "budgeted", transcriptPath: "/b.jsonl", cwd: WT, server: "/tmp/tmux-1000/agentglass,4242", at: 1_000 });
    notePaneAgent({ pane: P, sessionId: "someone-else", transcriptPath: "/s.jsonl", cwd: REPO, server: "/tmp/tmux-1000/default,777", at: 2_000 });
    expect(noteForSession("budgeted")?.cwd).toBe(WT);
    expect(noteForSession("never-seen")).toBeNull();
  });

  test("the notes move to a table keyed by server and pane, and the old table is left as older builds need it", () => {
    /* Every build before this one prepares `ON CONFLICT(pane_id)` against
       `pane_agent` when it loads. Rebuilt with a two-column key, SQLite
       refused that statement: an older build could not start on the same
       database, and one already running failed every hook. */
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
    d.exec(`ALTER TABLE pane_agent ADD COLUMN server TEXT NOT NULL DEFAULT ''`);
    d.run(`INSERT INTO pane_agent VALUES ('%1', 'kept', '/k.jsonl', '/home/dev/code/orbit', 5, '/tmp/tmux-1000/agentglass,1')`);
    d.run(`INSERT INTO pane_agent VALUES ('%2', 'unnamed', '/u.jsonl', '/home/dev/code/orbit', 6, '')`);
    const oldUpsert = `INSERT INTO pane_agent (pane_id, session_id, transcript_path, cwd, at, server) VALUES ('%1', 'old-build', '/o.jsonl', '/x', 9, '')
      ON CONFLICT(pane_id) DO UPDATE SET session_id = excluded.session_id`;
    ensurePaneNoteTable(d);
    const key = d.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_note)").all().filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(key).toEqual(["pane_id", "server"]);
    expect(d.query("SELECT session_id, server FROM pane_note ORDER BY at").all()).toEqual([
      { session_id: "kept", server: "/tmp/tmux-1000/agentglass,1" }, { session_id: "unnamed", server: "" },
    ]);
    /* An older build's statement still prepares and runs against its table. */
    expect(() => d.run(oldUpsert)).not.toThrow();
    const oldKey = d.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_agent)").all().filter((c) => c.pk > 0).map((c) => c.name);
    expect(oldKey).toEqual(["pane_id"]);
    /* A second server's %1 is a row of its own in the new table. */
    d.run(`INSERT INTO pane_note VALUES ('%1', 'other', '/o.jsonl', '/home/dev/code/orbit', 7, '/tmp/tmux-1000/default,2')`);
    expect(d.query("SELECT COUNT(*) AS n FROM pane_note WHERE pane_id = '%1'").get()).toEqual({ n: 2 });
    d.close();
  });

  test("what an older build wrote since is brought forward at every start, and a newer note is never set back", () => {
    /* An older build run on the same database writes the old table only.
       A Claude that `/clear`ed while it was up has its new conversation
       there; copied once, the new table kept the one from before the
       `/clear`, dated after the process started, and a reboot resumed it. */
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL, server TEXT NOT NULL DEFAULT '')`);
    const SRV = "/tmp/tmux-1000/agentglass,1";
    const now = Date.now();
    d.run(`INSERT INTO pane_agent VALUES ('%1', 'before-clear', '/a.jsonl', '/home/dev/code/orbit', ?, ?)`, [now - 3_000, SRV]);
    ensurePaneNoteTable(d);
    /* The older build: a `/clear` in %1, a fresh agent in %2. */
    d.run(`INSERT INTO pane_agent (pane_id, session_id, transcript_path, cwd, at, server) VALUES ('%1', 'after-clear', '/b.jsonl', '/home/dev/code/orbit', ?, ?)
      ON CONFLICT(pane_id) DO UPDATE SET session_id = excluded.session_id, transcript_path = excluded.transcript_path, at = excluded.at`, [now - 2_000, SRV]);
    d.run(`INSERT INTO pane_agent VALUES ('%2', 'fresh', '/c.jsonl', '/home/dev/code/orbit', ?, ?)`, [now - 2_000, SRV]);
    /* And this build again, whose own note for a third pane is newer than
       anything the older one wrote for it. */
    d.run(`INSERT INTO pane_note VALUES ('%3', 'newest', '/n.jsonl', '/home/dev/code/orbit', ?, ?)`, [now, SRV]);
    d.run(`INSERT INTO pane_agent VALUES ('%3', 'stale', '/s.jsonl', '/home/dev/code/orbit', ?, ?)`, [now - 1_000, SRV]);
    ensurePaneNoteTable(d);
    const rows = () => d.query<{ pane_id: string; session_id: string; transcript_path: string }, []>(
      "SELECT pane_id, session_id, transcript_path FROM pane_note ORDER BY pane_id").all();
    expect(rows()).toEqual([
      { pane_id: "%1", session_id: "after-clear", transcript_path: "/b.jsonl" },
      { pane_id: "%2", session_id: "fresh", transcript_path: "/c.jsonl" },
      { pane_id: "%3", session_id: "newest", transcript_path: "/n.jsonl" },
    ]);
    /* Idempotent: nothing moves when nothing was written. */
    ensurePaneNoteTable(d);
    expect(rows().map((r) => r.session_id)).toEqual(["after-clear", "fresh", "newest"]);
    d.close();
  });

  test("a read-only database is opened as it is, the sync that runs at every start included", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-panenote-ro-"));
    try {
      const file = join(dir, "notes.db");
      const w = new Database(file);
      w.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL, server TEXT NOT NULL DEFAULT '')`);
      ensurePaneNoteTable(w);
      w.run(`INSERT INTO pane_agent VALUES ('%1', 'later', '/l.jsonl', '/home/dev/code/orbit', 9, '')`);
      w.close();
      const r = new Database(file, { readonly: true });
      expect(() => ensurePaneNoteTable(r)).not.toThrow();
      expect(r.query("SELECT COUNT(*) AS n FROM pane_note").get()).toEqual({ n: 0 });
      r.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a table from before the server was recorded is copied with no server", () => {
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
    d.run(`INSERT INTO pane_agent VALUES ('%3', 'ancient', '/a.jsonl', '/home/dev/code/orbit', 5)`);
    ensurePaneNoteTable(d);
    expect(d.query("SELECT session_id, server FROM pane_note").all()).toEqual([{ session_id: "ancient", server: "" }]);
    d.close();
  });

  test("a database that never had either table gets the new one keyed by server and pane", () => {
    const d = new Database(":memory:");
    ensurePaneNoteTable(d);
    const key = d.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_note)").all().filter((c) => c.pk > 0).map((c) => c.name).sort();
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

describe("paneHeldSessions", () => {
  // The Diff view's "shared tree" flag counts live authors, and a session
  // waiting on a person for an hour is still one: it is sitting in its pane with
  // its edits on disk. The pane is the evidence — but only while the agent the
  // note was written for is still the one running in it.
  test("the session in a pane whose agent still runs where the note says", () => {
    notePaneAgent({ pane: "%9921", sessionId: "held", transcriptPath: "/t.jsonl", cwd: REPO });
    expect(paneHeldSessions([{ paneId: "%9921", agentCwds: [REPO] }]).has("held")).toBe(true);
  });

  test("a reused pane id with an agent somewhere else holds nobody", () => {
    notePaneAgent({ pane: "%9922", sessionId: "yesterday", transcriptPath: "/t.jsonl", cwd: REPO });
    expect(paneHeldSessions([{ paneId: "%9922", agentCwds: [WT] }]).has("yesterday")).toBe(false);
    expect(paneHeldSessions([{ paneId: "%9922" }]).size).toBe(0);
  });
});
