/**
 * Which worktree the agent in a tmux pane is working in.
 *
 * The panel already claimed to answer this and the answer was a scrape: read
 * the focused pane's xterm buffer, look for a worktree's folder name, take the
 * most recent one. Measured against a live fleet of five agents it found
 * nothing at all, and for four reasons no amount of tuning removes.
 *
 *   * **The name is not on screen.** The agent whose whole session was inside a
 *     worktree had zero occurrences of that worktree's folder anywhere in its
 *     pane — and so did the other four.
 *   * **There is no scrollback to widen the search to.** An agent TUI runs on
 *     the alternate screen, so tmux keeps no history for it (`history_size` 0,
 *     `alternate_on` 1) and neither does the terminal above it. "The last 250
 *     lines" is, in practice, the sixty rows currently drawn.
 *   * **The paths are in the folded parts.** Of 129 mentions of the worktree in
 *     that session's transcript, 2 were in prose. The rest were tool inputs —
 *     68 Bash commands, 6 Writes, 5 Edits — and the CLI draws those collapsed
 *     as "Ran 3 shell commands".
 *   * **And they were hours old.** The last one was printed at 09:28 and the
 *     screen was read at 11:37.
 *
 * The cwd is no better on its own, which is what sent the first attempt to the
 * screen in the first place: every process in that pane — fish, the CLI, its
 * MCP servers, its shells — reported the PARENT repo, because an agent reaches
 * into a worktree with `git -C` and absolute paths without ever moving.
 *
 * So this asks the two places that hold the answer as a fact rather than as
 * pixels:
 *
 *   * **the agent's own working directory**, for the agents that were started
 *     inside the worktree. /proc, an equality test, nothing parsed. The first
 *     attempt never covered this case either.
 *   * **the transcript it is writing**, for the ones that were not. Same file
 *     the CLI itself renders from, read from the tail: the structured tool
 *     inputs the screen folds away are all there.
 *
 * Only tool *inputs* — what the agent asked for — never tool results. That is
 * not tidiness: one `git worktree list` puts all 22 worktrees in the output at
 * the same instant, and a reader that counted those would answer with whichever
 * one it happened to see first, confidently and at random.
 *
 * The pane → transcript link is a fact too, and it comes from the hook.
 * agentglass's own send_event.py runs as a child of the agent, so it inherits
 * that pane's TMUX_PANE and every tool call now says where it came from. The
 * obvious shortcut does not work and was tried: `CLAUDE_CODE_SESSION_ID` is in
 * the environment of every child, but it is the id the process LAUNCHED with,
 * and on a session that has been resumed it names a transcript that does not
 * exist — measured on the one session this was written against.
 */
import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { db } from "./db.ts";
import { agentCwdsUnder } from "./paneloc.ts";

/**
 * One row per pane OF ONE TMUX SERVER: the key is the pane id and the server
 * together ("<socket path>,<server pid>", as the hook reads it out of $TMUX,
 * or "" from a hook that does not say).
 *
 * The pane id alone is not a pane. Every tmux server hands out `%0, %1…`,
 * the engine and the person's own tmux both run Claude, and hooks fire from
 * both — so keyed by the id alone, whichever server's `%2` fired last owned
 * the row. The restore sets another server's note aside, which left the
 * engine's agent photographed with only what its argv carried: nothing for a
 * Claude started fresh (a shell at the next boot, its conversation orphaned),
 * and the old id for a restored one that had `/clear`ed since (the conversation
 * it had left resumed at the next boot). A reboot is the same thing in time
 * rather than space: the new server hands the dead one's ids out again, under
 * a new pid.
 *
 * A NEW TABLE, NOT THE OLD ONE REBUILT. `pane_agent` is keyed by the id
 * alone, and every build before this one prepares `ON CONFLICT(pane_id)`
 * against it when it loads: rebuilt with a two-column key, SQLite refuses
 * that statement, so an older build installed afterwards could not start,
 * and one still running would fail every hook it was sent (both measured on
 * a copy of the table). So `pane_note` is created beside it, brought up to
 * date from it at every start, and `pane_agent` is left for whichever older
 * build still writes it.
 *
 * Ceiling: the pid is a server's name for its life, not forever — a server
 * after a reboot can draw the pid of the one before it. Its row then carries
 * the dead server's note until its own hook fires, and the restore tells the
 * two apart by time (`noteIsThisAgents`), as it did before the server was in
 * the key.
 *
 * Exported so the migration can be run against a database built by hand.
 */
export function ensurePaneNoteTable(d: Database): void {
  d.exec(`
CREATE TABLE IF NOT EXISTS pane_note (
  pane_id         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  at              INTEGER NOT NULL,
  server          TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (pane_id, server)
)`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_pane_note_session ON pane_note (session_id, at)");
  /* At every start, not once: the notes an older build wrote since. One run
     on the same database writes the old table only, and a Claude that
     `/clear`ed while it was up has its new conversation there alone. Copied
     only when this table was made, the note here kept the conversation from
     before the `/clear`, dated after the process started, so the restore
     took it for this agent's and a reboot resumed the wrong one. Only a newer
     row replaces a note, so a note this build wrote since is never set back,
     and nothing moves when nothing was written. A table from before the
     server was recorded has no such column, and its rows name none.
     Ceiling: two builds running on one database at once are brought
     together at the next start, not while both run. */
  const cols = d.query<{ name: string }, []>("PRAGMA table_info(pane_agent)").all().map((c) => c.name);
  if (!cols.length) return;
  const server = cols.includes("server") ? "server" : "''";
  /* A WHERE is required: without one SQLite reads the `ON` as the start of a
     join. And it is this one because `notePaneAgent` writes the legacy row
     too, as the newest hook from EITHER server: copied back under "no server"
     it would be read as this server's pane. Only a row newer than every note
     for that pane id is one an older build wrote since, and only that is
     brought forward. */
  try {
    d.exec(`INSERT INTO pane_note (pane_id, session_id, transcript_path, cwd, at, server)
SELECT pane_id, session_id, transcript_path, cwd, at, ${server} FROM pane_agent
WHERE NOT EXISTS (SELECT 1 FROM pane_note n WHERE n.pane_id = pane_agent.pane_id AND n.at >= pane_agent.at)
ON CONFLICT(pane_id, server) DO UPDATE SET session_id = excluded.session_id, transcript_path = excluded.transcript_path,
  cwd = excluded.cwd, at = excluded.at WHERE excluded.at > pane_note.at`);
  } catch { /* a read-only database keeps the notes it has */ }
}

/** How long a row outlives its last hook. A pane id is only reused within a
 *  server, and nothing overwrites a dead server's rows now, so they would
 *  otherwise be kept for ever. Long, because a live agent's row is dropped by
 *  the same rule: one that has fired no hook in this long, on a server that
 *  has been up this long, comes back from the next boot as a shell unless its
 *  own command line carries its `--resume`. */
const KEEP_MS = 90 * 24 * 60 * 60_000;

ensurePaneNoteTable(db);
try { db.run("DELETE FROM pane_note WHERE at < ?", [Date.now() - KEEP_MS]); } catch { /* a read-only database keeps its rows */ }

/** tmux's own spelling of a pane id. Anything else came from somewhere that
 *  should not be writing here, and is dropped rather than stored. */
const PANE_ID = /^%\d{1,10}$/;

export interface PaneAgentNote {
  pane_id: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  at: number;
  /** "<socket path>,<server pid>" of the tmux the hook fired in, or "". */
  server: string;
}

const noteUpsert = db.query(`
INSERT INTO pane_note (pane_id, session_id, transcript_path, cwd, at, server)
VALUES ($pane_id, $session_id, $transcript_path, $cwd, $at, $server)
ON CONFLICT(pane_id, server) DO UPDATE SET
  session_id = excluded.session_id,
  transcript_path = excluded.transcript_path,
  cwd = excluded.cwd,
  at = excluded.at`);

/** A tmux server as the hook names it: an absolute socket path and a pid. */
const TMUX_SERVER = /^\/[^\0\n\r]{1,1024},\d{1,10}$/;

const noteRead = db.query<PaneAgentNote, [string]>(
  "SELECT * FROM pane_note WHERE pane_id = ? ORDER BY at DESC LIMIT 1",
);

/* The newer of this server's row and one from a hook that named no server —
   an agent started with `env -u TMUX` keeps TMUX_PANE and names none. Which
   of the two is this agent's is `noteIsThisAgents`'s question. */
const noteReadOn = db.query<PaneAgentNote, [string, string]>(
  "SELECT * FROM pane_note WHERE pane_id = ?1 AND server IN (?2, '') ORDER BY at DESC LIMIT 1",
);

const noteBySession = db.query<PaneAgentNote, [string]>(
  "SELECT * FROM pane_note WHERE session_id = ? ORDER BY at DESC LIMIT 1",
);

const recentPanes = db.query<{ pane_id: string; session_id: string; cwd: string; at: number }, [number, number]>(
  "SELECT pane_id, session_id, cwd, at FROM pane_note WHERE at >= ? ORDER BY at DESC LIMIT ?",
);

/**
 * Remember which agent is in which pane.
 *
 * One row per pane of a server, overwritten: a pane holds one agent at a
 * time, and the interesting question is always about the one in it now. Persisted rather than
 * kept in memory because the pane an agent has gone quiet in is exactly the
 * pane somebody asks about later — an in-memory map is empty after a restart
 * until the agent happens to run another tool, which for an idle agent is
 * never.
 */
export function notePaneAgent(n: { pane: string; sessionId: string; transcriptPath: string; cwd: string; at?: number; server?: string }): boolean {
  if (!PANE_ID.test(n.pane) || !n.transcriptPath || !n.cwd) return false;
  const row = {
    $pane_id: n.pane, $session_id: n.sessionId || "unknown",
    $transcript_path: n.transcriptPath, $cwd: n.cwd, $at: n.at ?? Date.now(),
  };
  const full = { ...row, $server: n.server && TMUX_SERVER.test(n.server) ? n.server : "" };
  noteUpsert.run(full as never);
  noteLegacy(full);
  return true;
}

/*
 * THE OLD TABLE IS KEPT CURRENT, NOT ONLY LEFT STANDING. An older build reads
 * `pane_agent` and nothing else, so a note that went only to `pane_note` was
 * one a downgrade never saw: the pane still held the conversation from before
 * every `/clear` since the upgrade, and the restore resumed that one. So the
 * row is written here as well, in the five columns the oldest reader has and
 * with the conflict target its own upsert names.
 *
 * Only a table keyed by the pane id alone. No table is created (an older
 * build makes its own), and one keyed by two columns — a rebuild some branch
 * made — is left to the next start rather than failing the note that matters.
 * Asked at every write, not once, because the table can be made after this
 * module loads. Ceiling: one row per pane id across every tmux server, the
 * older build's own rule, so the newest hook from either server wins.
 */
function noteLegacy(row: { $pane_id: string; $session_id: string; $transcript_path: string; $cwd: string; $at: number; $server: string }): void {
  const cols = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(pane_agent)").all();
  const key = cols.filter((c) => c.pk > 0);
  if (key.length !== 1 || key[0]!.name !== "pane_id") return;
  /* A build between the two added the server column and reads it: the row
     names the server it now describes, not the one that wrote it before. */
  const withServer = cols.some((c) => c.name === "server");
  const { $server: _server, ...five } = row;
  try {
    db.query(withServer
      ? `INSERT INTO pane_agent (pane_id, session_id, transcript_path, cwd, at, server)
VALUES ($pane_id, $session_id, $transcript_path, $cwd, $at, $server)
ON CONFLICT(pane_id) DO UPDATE SET session_id = excluded.session_id, transcript_path = excluded.transcript_path,
  cwd = excluded.cwd, at = excluded.at, server = excluded.server`
      : `INSERT INTO pane_agent (pane_id, session_id, transcript_path, cwd, at)
VALUES ($pane_id, $session_id, $transcript_path, $cwd, $at)
ON CONFLICT(pane_id) DO UPDATE SET session_id = excluded.session_id, transcript_path = excluded.transcript_path,
  cwd = excluded.cwd, at = excluded.at`).run((withServer ? row : five) as never);
  } catch { /* a read-only or locked database: the note that counts is already written */ }
}

/** The same, from a raw hook body — the shape /ingest already has in hand. */
export function notePaneFromHook(body: {
  session_id?: string;
  tmux_pane?: unknown;
  tmux_server?: unknown;
  payload?: Record<string, unknown>;
}): boolean {
  const pane = typeof body.tmux_pane === "string" ? body.tmux_pane : "";
  const p = body.payload ?? {};
  const transcriptPath = typeof p.transcript_path === "string" ? p.transcript_path : "";
  const cwd = typeof p.cwd === "string" ? p.cwd : "";
  if (!pane || !transcriptPath || !cwd) return false;
  const server = typeof body.tmux_server === "string" ? body.tmux_server : "";
  return notePaneAgent({ pane, sessionId: body.session_id ?? "unknown", transcriptPath, cwd, server });
}

/**
 * The pane a session is sitting in — the reverse of the lookup above.
 *
 * Newest first, because a session that moved (a pane closed and the agent
 * restarted in another) has more than one row, and the answer wanted is always
 * "where is it now". Null when the hook never reported a pane: the agent is not
 * in tmux, or is running somewhere the hook could not see.
 */
export function paneForSession(sessionId: string): string | null {
  if (!sessionId) return null;
  return paneBySession.get(sessionId)?.pane_id ?? null;
}

const paneBySession = db.query<{ pane_id: string }, [string]>(
  "SELECT pane_id FROM pane_note WHERE session_id = ? ORDER BY at DESC LIMIT 1",
);

/**
 * The note for a pane.
 *
 * With `server`, that server's pane: the newer of its own row and one from a
 * hook that did not name its server — which may be anybody's, and whether it is this
 * agent's is the caller's question (`noteIsThisAgents`). Never another
 * server's.
 *
 * Without (or with "", a server that could not be read), the newest row for
 * the id on any server: what a row keyed by the
 * id alone answered, kept for the readers that cannot say which server they
 * mean. Those readers also check the note against the pane's own agent.
 */
export function paneAgentNote(pane: string, server?: string): PaneAgentNote | null {
  if (!PANE_ID.test(pane)) return null;
  return (server ? noteReadOn.get(pane, server) : noteRead.get(pane)) ?? null;
}

/**
 * A session's own newest note, found by the session.
 *
 * `paneAgentNote(paneForSession(s))` asks the same question through the pane
 * id, and the pane id is the half another server can have taken since: its
 * newest row may be a different conversation's.
 */
export function noteForSession(sessionId: string): PaneAgentNote | null {
  if (!sessionId) return null;
  return noteBySession.get(sessionId) ?? null;
}

/**
 * The sessions an agent is running for, right now, in one of these panes.
 *
 * The same rule `paneDirs` applies to one pane: a note is believed only while
 * the pane still has an agent running in the directory the note recorded,
 * because tmux reuses pane ids and a note outlives the agent it was written for.
 *
 * This is the liveness that last-seen cannot give. An agent that finished its
 * turn and is waiting on a person fires no hooks — for an hour, if the person
 * is at lunch — and it is still there, with its edits still on disk.
 */
export function paneHeldSessions(panes: { paneId: string; agentCwds?: string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const p of panes) {
    const n = paneAgentNote(p.paneId);
    if (n && n.session_id !== "unknown" && (p.agentCwds ?? []).includes(n.cwd)) out.add(n.session_id);
  }
  return out;
}

/** Fields of a tool's input that name a place. `command` is the whole shell
 *  line — `git -C <worktree> status` is the commonest way an agent touches a
 *  worktree it is not standing in, and it is the field that carried the answer
 *  in 68 of the 129 mentions measured. */
const INPUT_FIELDS = ["file_path", "path", "notebook_path", "cwd", "command"];

/** An absolute path, as it appears inside a shell line or a field. Deliberately
 *  conservative about the characters it will cross, so a path lifted out of a
 *  command stops at the quote or the `&&` that follows it. */
const ABS_PATH = /\/(?:[A-Za-z0-9._~@%+=-]+\/)*[A-Za-z0-9._~@%+=-]+/g;

/**
 * The absolute paths an agent most recently asked for, newest first.
 *
 * Text in, paths out, so the interesting cases can be tested without a
 * transcript on disk: a half line at the head (the tail of a file always
 * starts mid-line), a tool result naming twenty worktrees at once, an entry
 * that is not JSON at all.
 *
 * Capped, and the cap is the point — the caller only wants the first of these
 * that is a worktree it knows, so reading further back is spent effort.
 */
export function dirsFromTranscript(text: string, cap = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    const line = lines[i]!;
    // Cheap reject first: most lines of a transcript are prose or results, and
    // JSON.parse on a 24MB file's worth of them is the whole cost of this.
    if (!line.includes('"tool_use"')) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = (entry as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; input?: unknown };
      if (b?.type !== "tool_use" || !b.input || typeof b.input !== "object") continue;
      const input = b.input as Record<string, unknown>;
      for (const field of INPUT_FIELDS) {
        const v = input[field];
        if (typeof v !== "string") continue;
        for (const m of v.matchAll(ABS_PATH)) {
          const path = m[0];
          if (seen.has(path)) continue;
          seen.add(path);
          out.push(path);
          if (out.length >= cap) return out;
        }
      }
    }
  }
  return out;
}

/**
 * How far back to read.
 *
 * Half a megabyte of a file that grows to twenty-four: on the session this was
 * measured against, the most recent mention of the worktree sat 3KB from the
 * end, because an agent working in a worktree names it constantly. A window
 * this size covers a long stretch of idling after that and still costs one
 * read, and the answer is cached until the file grows anyway.
 */
const TAIL_BYTES = 512 * 1024;

/** The last of a file, without reading the rest of it. */
export function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    if (!len) return "";
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    // No transcript yet, or it moved. The caller falls back to the cwd.
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** Keyed by size as well as path: a transcript only ever grows, so an unchanged
 *  size means the same tail and the same answer. This is polled while a menu is
 *  open, and re-reading half a megabyte per poll for an idle agent is the kind
 *  of cost that gets a feature turned off. */
let tailCache: { path: string; size: number; dirs: string[] } | null = null;

function transcriptDirs(path: string): string[] {
  let size = -1;
  try {
    const fd = openSync(path, "r");
    try { size = fstatSync(fd).size; } finally { closeSync(fd); }
  } catch { return []; }
  if (tailCache && tailCache.path === path && tailCache.size === size) return tailCache.dirs;
  const dirs = dirsFromTranscript(readTail(path));
  tailCache = { path, size, dirs };
  return dirs;
}

/** Forget the cached tail. Tests write a transcript, read it, then write more. */
export function resetTailCache(): void { tailCache = null; }

/**
 * Where the agent in this pane has been working, most certain first.
 *
 * The list is deliberately raw — directories, not worktrees. Which of them is a
 * worktree of the repo on screen is the caller's question, and it is the caller
 * (the panel, which already lists them) that holds that list. Answering
 * "worktree X" here would mean this module deciding what counts as the current
 * project, which is a second, worse copy of a decision the picker already makes.
 *
 * The agent's own directories come first because they are certainties rather
 * than the most recent thing it typed. For an agent standing in the parent repo
 * — the case this was written for — none of them will match a worktree and the
 * transcript's paths behind them will.
 */
export function paneDirs(
  paneId: string,
  panePid: number,
  cwdsOf: (pid: number) => string[] = agentCwdsUnder,
): { pane: string; dirs: string[] } {
  const cwds = cwdsOf(panePid);
  const note = paneAgentNote(paneId);
  // Only believe the note if the agent it was written for is still the one in
  // this pane. tmux reuses pane ids: %3 outlives the agent that was in it, and
  // a note from the last one would otherwise send you to a worktree belonging
  // to a session that ended yesterday.
  const live = note && cwds.includes(note.cwd) ? note : null;
  const dirs = [...cwds];
  if (live) for (const d of transcriptDirs(live.transcript_path)) if (!dirs.includes(d)) dirs.push(d);
  return { pane: paneId, dirs };
}

/**
 * Every pane an agent's hooks have fired from recently.
 *
 * The reverse of `paneAgentNote`, which answers about one pane. This is the
 * whole list, and it exists because the Lantern had no other way to know an agent
 * was alive: rows came only from `POST /agents/status`, and nothing on this
 * machine calls it — no bin, hook, skill or doc mentions the route. Six agents
 * in tmux and an empty board beside the deputy.
 *
 * The sighting was already here. `send_event.py` posts `session_id`,
 * `tmux_pane` and `cwd` on every hook and `notePaneFromHook` writes them: 296
 * rows on this machine the day this was added, none of them drawn anywhere.
 *
 * WINDOWED, because the table keeps a row per pane for as long as the pane id
 * is not reused, and a sighting from last week is not evidence that anything is
 * there now. A day is generous for "is this agent still around" and short
 * enough that a laptop shut over a weekend does not come back claiming a crowd.
 */
export function recentPaneAgents(o: { sinceMs?: number; now?: number; cap?: number } = {}):
{ paneId: string; sessionId: string; cwd: string; at: number }[] {
  const now = o.now ?? Date.now();
  const since = now - (o.sinceMs ?? 24 * 60 * 60_000);
  try {
    return recentPanes.all(since, Math.max(1, o.cap ?? 60))
      .map((r) => ({ paneId: r.pane_id, sessionId: r.session_id, cwd: r.cwd, at: r.at }));
  } catch { return []; } // a database that cannot answer is not a reason to lose the board
}
