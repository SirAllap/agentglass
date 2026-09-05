/*
 * THE LANTERN'S BOARD, assembled from every part of the machine at once.
 *
 * `agentboard.ts` is the JOIN and stays pure — its readers are injected so a
 * test can pin who wins when sources disagree. This is the module that goes
 * and gets them: the tmux socket for the panes, git for the worktrees and
 * whether a branch is in, the deputy's own run table, the hooks' sightings,
 * the session names, and who is stopped on a person. One function, because
 * two surfaces need the same answer — the `/agents/board` route the view and
 * the rail read, and the terminal's "Ask about the field", which opens a chat
 * on the engine with this same board as its first message. Two copies of the
 * assembly would be two boards that could disagree.
 */
import { tmux } from "./tmuxpane.ts";
import * as AgentBoard from "./agentboard.ts";
import * as Work from "./understudy-work.ts";
import { recentPaneAgents } from "./panewt.ts";
import { db, sessionNames, latestWaits, sessionRoles, setSessionRole, sessionsWhosePromptStarts } from "./db.ts";
import { pendingGates } from "./gate.ts";
import { lanternWatchMinutes } from "./config.ts";

async function runGitIn(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const errText = await new Response(p.stderr).text();
  return { ok: (await p.exited) === 0, out: (out + errText).slice(0, 4000) };
}

import { LANTERN_PROMPT_MARK } from "./lanternmark.ts";
export { LANTERN_PROMPT_MARK };

/** Sessions that are the Lantern's own chat. Persisted (session_role) and
 *  cached here; found by the role their pane carried, by the prompt they were
 *  opened with, or — once, at boot — by the prompt already on record. */
const lanternSessions = new Set<string>();
let loaded = false;
function load(): void {
  if (loaded) return;
  loaded = true;
  for (const [id, role] of sessionRoles()) if (role === "lantern") lanternSessions.add(id);
  for (const id of sessionsWhosePromptStarts(LANTERN_PROMPT_MARK)) noteLanternSession(id);
}
export function noteLanternSession(id: string): void {
  if (!id || lanternSessions.has(id)) return;
  lanternSessions.add(id);
  setSessionRole(id, "lantern");
}
export const isLanternSession = (id: string | undefined): boolean => { load(); return !!id && lanternSessions.has(id); };
/** What `/ingest` asks of every hook event: is this the Lantern's chat? */
export function hookSaysLantern(body: { role?: unknown; hook_event_type?: unknown; payload?: unknown }): boolean {
  if (body.role === "lantern") return true;
  if (body.hook_event_type !== "UserPromptSubmit") return false;
  const prompt = (body.payload as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" && prompt.trimStart().startsWith(LANTERN_PROMPT_MARK);
}
export function __resetLanternSessions(): void { lanternSessions.clear(); loaded = false; }

/*
 * WHAT A CARD SAYS, beyond the row: who this is, what it has done, what it
 * touched. "Each card has to carry plenty of information about what it is, who
 * it is, what it is doing, what it has done" — and all of it from records this app
 * already keeps, none of it guessed: the sessions table for the model, the
 * counts and the cost; the events table for the last tool and the last thing
 * a person asked; git for the branch's commits and the working tree.
 */
export interface SessionFacts {
  model?: string;
  tools: number;
  errors: number;
  turns: number;
  cost: number;
  startedAt?: number;
  lastSeen?: number;
  /** The last tool call, in the words it carried: a Bash description, a file
   *  path, a pattern — what the agent was doing a moment ago. */
  lastTool?: { name: string; what: string; at: number };
  /** The last thing a person typed at it. */
  lastAsk?: { text: string; at: number };
  permissionMode?: string;
}
export interface GitFacts {
  /** Files changed and not committed. */
  dirty: number;
  /** Commits on this branch that its base does not have. */
  ahead: number;
  lastCommit?: { subject: string; at: number };
  /** When this was read; the view can say "as of". */
  at: number;
}
export type LanternCard = AgentBoard.BoardRow & { facts?: SessionFacts; git?: GitFacts };

/** What one tool call was doing, from its input, in a person's words. */
export function toolWhat(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const short = (p: string) => p.replace(/^\/home\/[^/]+\//, "~/").split("/").slice(-3).join("/");
  const pick = str("description") || (str("file_path") ? short(str("file_path")) : "") || str("pattern") || str("query")
    || str("command") || str("title") || str("prompt") || str("url") || str("skill") || str("subagent_type") || "";
  return pick.replace(/\s+/g, " ").trim().slice(0, 120);
}

const factsQ = () => ({
  sessions: db.query<{ session_id: string; model_name: string | null; tool_count: number; error_count: number; cost_usd: number; started_at: number | null; last_seen: number | null }, string[]>(
    "SELECT session_id, model_name, tool_count, error_count, cost_usd, started_at, last_seen FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))"),
  turns: db.query<{ session_id: string; n: number }, string[]>(
    "SELECT session_id, COUNT(*) AS n FROM events WHERE hook_event_type = 'Stop' AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id"),
  lastTool: db.query<{ session_id: string; tool_name: string; payload: string | null; timestamp: number }, string[]>(
    `SELECT e.session_id, e.tool_name, e.payload, e.timestamp FROM events e
       JOIN (SELECT session_id, MAX(id) AS id FROM events WHERE hook_event_type = 'PreToolUse' AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id) m ON m.id = e.id`),
  lastAsk: db.query<{ session_id: string; payload: string | null; timestamp: number }, string[]>(
    `SELECT e.session_id, e.payload, e.timestamp FROM events e
       JOIN (SELECT session_id, MAX(id) AS id FROM events WHERE hook_event_type = 'UserPromptSubmit' AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id) m ON m.id = e.id`),
});
let queries: ReturnType<typeof factsQ> | null = null;

export function sessionFacts(ids: string[]): Map<string, SessionFacts> {
  const out = new Map<string, SessionFacts>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const q = (queries ??= factsQ());
  const arg = JSON.stringify(want);
  for (const r of q.sessions.all(arg)) {
    out.set(r.session_id, {
      model: r.model_name ?? undefined, tools: r.tool_count ?? 0, errors: r.error_count ?? 0, turns: 0, cost: r.cost_usd ?? 0,
      startedAt: r.started_at ?? undefined, lastSeen: r.last_seen ?? undefined,
    });
  }
  const at = (id: string) => out.get(id) ?? (out.set(id, { tools: 0, errors: 0, turns: 0, cost: 0 }), out.get(id)!);
  for (const r of q.turns.all(arg)) at(r.session_id).turns = r.n;
  for (const r of q.lastTool.all(arg)) {
    let input: unknown = null, mode = "";
    try { const p = JSON.parse(r.payload ?? "{}"); input = p.tool_input; mode = typeof p.permission_mode === "string" ? p.permission_mode : ""; } catch { /* a payload is not a fact worth failing over */ }
    const f = at(r.session_id);
    f.lastTool = { name: r.tool_name, what: toolWhat(r.tool_name, input), at: r.timestamp };
    if (mode) f.permissionMode = mode;
  }
  for (const r of q.lastAsk.all(arg)) {
    let text = "";
    try { const p = JSON.parse(r.payload ?? "{}"); text = typeof p.prompt === "string" ? p.prompt : ""; } catch { /* same */ }
    text = text.replace(/\s+/g, " ").trim();
    if (text) at(r.session_id).lastAsk = { text: text.slice(0, 160), at: r.timestamp };
  }
  return out;
}

/* Git per worktree, remembered for half a minute: the view reads every five
   seconds while it is open, and a `git status` on a large checkout is not
   free — eight worktrees at five seconds would be the board's whole budget. */
const GIT_FACTS_TTL_MS = 30_000;
const gitCache = new Map<string, GitFacts>();
export function __resetGitFacts(): void { gitCache.clear(); }

async function gitFactsFor(path: string, base: string, now: number): Promise<GitFacts | null> {
  const had = gitCache.get(path);
  if (had && now - had.at < GIT_FACTS_TTL_MS) return had;
  const status = await runGitIn(["status", "--porcelain"], path).catch(() => ({ ok: false, out: "" }));
  if (!status.ok) return null;
  const dirty = status.out.split("\n").filter((l) => l.trim()).length;
  const ahead = base
    ? await runGitIn(["rev-list", "--count", `${base}..HEAD`], path).then((r) => (r.ok ? Number(r.out.trim()) || 0 : 0)).catch(() => 0)
    : 0;
  const last = await runGitIn(["log", "-1", "--format=%s%x00%ct"], path).catch(() => ({ ok: false, out: "" }));
  const [subject = "", ct = ""] = last.ok ? last.out.trim().split("\0") : [];
  const facts: GitFacts = { dirty, ahead, at: now, ...(subject ? { lastCommit: { subject: subject.slice(0, 120), at: Number(ct) * 1000 } } : {}) };
  gitCache.set(path, facts);
  return facts;
}

export async function boardNow(): Promise<LanternCard[]> {
  const panes = await tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{window_name}\t#{pane_current_path}"])
    .then((r) => (r.ok ? r.stdout.split("\n") : []).map((l) => {
      const [paneId = "", name = "", cwd = ""] = l.split("\t");
      return { paneId, name, cwd };
    }).filter((x) => x.paneId.startsWith("%")))
    .catch(() => [] as { paneId: string; name: string; cwd: string }[]);
  const runs = Work.runningRuns().map((r) => ({
    title: r.title, worktree: r.worktree, branch: r.branch, startedAt: r.startedAt,
  }));

  /*
   * GIT IS ASKED IN THE REPOSITORY THE ROW IS ACTUALLY IN.
   *
   * The first version asked one repository for everything — the configured
   * workspace root — and on this machine that root is the employer's
   * checkout, whose HEAD is a `master` none of these branches has ever been
   * near. Every row read "not in master": true, meaningless, and exactly
   * the kind of answer that sends somebody looking for work that is
   * already in.
   *
   * So the checkouts the rows THEMSELVES name are the starting point, each
   * resolved to the repository that owns it, and each repository asked
   * once. A repository that will not answer contributes nothing rather
   * than a wrong answer.
   */
  /* The hooks' panes too: a session that never posted a status still runs
     somewhere, and without its checkout here its branch reads as nothing. */
  const hooks = recentPaneAgents({});
  const claimed = [...AgentBoard.board(), ...runs.map((r) => ({ worktree: r.worktree })), ...hooks.map((h) => ({ worktree: h.cwd }))]
    .map((a) => (a.worktree ?? "").trim()).filter(Boolean);
  const trees: { path: string; branch: string }[] = [];
  const landedBy: Record<string, { landed: boolean; into: string }> = {};
  const seenRepo = new Set<string>();
  for (const at of new Set(claimed)) {
    /* The repository, not the checkout: every worktree of one repository
       shares a `.git`, and its parent is the primary checkout — the one
       whose HEAD is the branch everything here is cut from. */
    const common = await runGitIn(["rev-parse", "--git-common-dir"], at).catch(() => ({ ok: false, out: "" }));
    if (!common.ok) continue;
    const dir = common.out.trim();
    const root = (dir.startsWith("/") ? dir : `${at}/${dir}`).replace(/\/\.git\/?$/, "");
    if (seenRepo.has(root)) continue;
    seenRepo.add(root);

    const list = await runGitIn(["worktree", "list", "--porcelain"], root).catch(() => ({ ok: false, out: "" }));
    let path = "";
    for (const line of (list.ok ? list.out : "").split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.startsWith("branch ")) trees.push({ path, branch: line.slice(7).replace("refs/heads/", "").trim() });
    }

    const into = await runGitIn(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(() => ({ ok: false, out: "" }));
    const merged = await runGitIn(["for-each-ref", "--format=%(refname:short)", "--merged", "HEAD", "refs/heads/"], root)
      .catch(() => ({ ok: false, out: "" }));
    if (!into.ok || !merged.ok) continue;
    const ref = into.out.trim();
    const inIt = new Set(merged.out.split("\n").map((l) => l.trim()).filter(Boolean));
    for (const t of trees) {
      if (t.branch && landedBy[t.branch] === undefined) landedBy[t.branch] = { landed: inIt.has(t.branch), into: ref };
    }
  }
  /*
   * The panes an agent's own hooks fired from. tmux cannot tell an agent
   * apart from an editor; a hook can, because only a live agent fires one —
   * and this was the source the board had been missing entirely, which is
   * why it showed nobody but the clone.
   */
  /*
   * WHAT EACH ONE IS ACTUALLY CALLED, not the pane it happens to sit in. A
   * hook carries a `sessionId` and nothing an eye can read; the same session
   * already has a name in this same database. Batched by the handful of ids
   * this page is actually drawing, never the whole table.
   */
  const names = sessionNames(hooks.map((h) => h.sessionId));
  /*
   * WHO IS STOPPED ON A PERSON. Two sources, both facts rather than pane
   * text: the session's newest hook event being Claude Code saying it
   * stopped for permission or for the next prompt (db.ts, noteWaitFromHook);
   * and a tool call held at this app's own gate, which is a person's to
   * decide by construction. The gate outranks the notification for the same
   * session — it is the more specific fact.
   */
  const saidSessions = AgentBoard.board().map((a) => a.session ?? "").filter(Boolean);
  const waiting = new Map<string, { kind: "permission" | "input" | "gate"; why: string; since: number }>();
  for (const [id, w] of latestWaits([...new Set([...hooks.map((h) => h.sessionId), ...saidSessions])])) waiting.set(id, w);
  for (const g of pendingGates()) {
    waiting.set(g.session_id, { kind: "gate", why: `held at the gate: ${g.tool_name}${g.summary ? ` — ${g.summary}` : ""}`.slice(0, 160), since: g.created });
  }
  /* The observer, marked: the view sets it aside and the counts skip it; a
     wait on it is a person mid-conversation, never a finding. */
  /* A status row the Lantern itself posted (a reminder that reached it before
     it was marked) is not a second agent: dropped before the merge, so the
     chat is one row, its pane's, and never "lantern" beside "Lantern". */
  const said = AgentBoard.board().filter((a) => !isLanternSession(a.session));
  const rows: LanternCard[] = AgentBoard.merged({ said, hooks, panes, trees, runs, landedBy, names, waiting }).map((r) =>
    isLanternSession(r.session) ? { ...r, role: "lantern" as const, needsYou: undefined, state: r.state === "waiting" ? "idle" : r.state } : r);

  /* The card's facts. Sessions in one query each; git per distinct worktree,
     cached, against the base the landed check already found. */
  const facts = sessionFacts(rows.map((r) => r.session ?? ""));
  const now = Date.now();
  const gitBy = new Map<string, GitFacts | null>();
  for (const wt of new Set(rows.map((r) => r.worktree ?? "").filter(Boolean))) {
    const branch = rows.find((r) => r.worktree === wt)?.branch ?? "";
    const into = branch && landedBy[branch]?.into;
    gitBy.set(wt, await gitFactsFor(wt, into && into !== branch ? into : "", now));
  }
  for (const r of rows) {
    const f = r.session ? facts.get(r.session) : undefined;
    if (f) r.facts = f;
    const g = r.worktree ? gitBy.get(r.worktree) : undefined;
    if (g) r.git = g;
  }
  return rows;
}

const here = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() ?? p : "");
const ago = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / (60 * 24))}d`;
};
const waitWord = (w: NonNullable<AgentBoard.BoardRow["needsYou"]>) =>
  w.kind === "permission" ? "needs your permission" : w.kind === "gate" ? "held at the gate" : "waiting for your next prompt";

/**
 * The field as text — Lantern's "what's going on" readout, in its order:
 * who needs you first, then every agent, working before idle. What the
 * terminal chat opens with, so the person asks the follow-up in their own
 * words against what is true now rather than what the pane text suggests.
 */
export function fieldReadout(all: AgentBoard.BoardRow[], now = Date.now()): string {
  const rows = all.filter((r) => r.role !== "lantern");
  const need = rows.filter((r) => r.needsYou);
  const working = rows.filter((r) => !r.needsYou && r.state === "working");
  const idle = rows.filter((r) => !r.needsYou && r.state === "idle");
  const line = (r: AgentBoard.BoardRow) => {
    const bits = [r.name];
    if (r.needsYou) bits.push(`${waitWord(r.needsYou)} for ${ago(r.needsYou.since, now)} — "${r.needsYou.why}"`);
    if (r.doing) bits.push(`on: ${r.doing}`);
    if (r.worktree || r.branch) bits.push([here(r.worktree), r.branch].filter(Boolean).join(" @ "));
    if (r.paneId) bits.push(`pane ${r.paneId}`);
    return `- ${bits.join(" · ")}`;
  };
  const out: string[] = [];
  out.push(need.length ? `${need.length} agent${need.length === 1 ? "" : "s"} stopped on you:` : "Nobody is stopped on you.");
  out.push(...need.map(line));
  out.push("", `Working (${working.length}):`, ...working.map(line));
  out.push("", `Idle (${idle.length}):`, ...idle.map(line));
  return out.join("\n");
}

/**
 * The first message of the Lantern's chat, and where to run it.
 *
 * The prompt is composed HERE, never sent by the client: the terminal socket
 * takes commands by name and looks the text up, which is what keeps a
 * websocket reachable from the UI from being a way to run arbitrary prompts
 * on the engine. The checkout is the most pressing agent's (rows arrive in
 * Lantern's order), so the chat has a repository under it; a field with no
 * checkout falls back to whatever the caller offers.
 */
export async function lanternChat(fallbackCwd: string): Promise<{ cwd: string; prompt: string; rows: AgentBoard.BoardRow[] }> {
  const rows = await boardNow();
  const watchEvery = lanternWatchMinutes();
  const cwd = rows.find((r) => r.worktree)?.worktree || fallbackCwd;
  const prompt = [
    `${LANTERN_PROMPT_MARK}: you read the field and answer questions about it.`,
    "Here is every agent on this machine right now, as the Lantern sees it:",
    "",
    fieldReadout(rows),
    "",
    "Answer questions about this field from the list above only. Do not start, stop or message any agent, and do not edit any repository.",
    `The app's own watch re-reads this field every ${watchEvery} minutes and notifies the person when somebody is still stopped on them, a worker's window vanished, or claimed work has gone quiet — you do not need to poll or schedule anything.`,
    "Begin by saying, in one line, who needs me and what the rest are on.",
  ].join("\n");
  return { cwd, prompt, rows };
}
