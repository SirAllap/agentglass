/*
 * THE ORCHESTRATOR'S SEAT — somebody sitting in front of the board.
 *
 * The app already had eyes and hands and nobody in the chair. The Lantern
 * reads the field and answers when asked, and says so in its own rules:
 * "starts, stops, queues nothing". Named agents will start, prompt and stop
 * anything by name, but only when a script asks them to. What was missing is
 * the post itself — an agent whose whole job is to know who is working on
 * what, who is stopped and why, and to answer for them.
 *
 * Three decisions worth keeping:
 *
 * ONE PER PROJECT, KEYED BY ROOT. The rules an orchestrator runs by are the
 * project's, not the machine's: what may leave the machine, who merges, which
 * tracker exists. So the seat is a row per checkout root (`seat` in db.ts) and
 * its rules are a file per checkout root (seatdoctrine.ts), and a seat may be
 * opened at the root of any project this app knows — not only the open one,
 * which is a deliberate widening of what a write may touch and is why
 * `seatable()` below checks the project list rather than `inScope`.
 *
 * THE PROMPT IS COMPOSED HERE. The mark, the doctrine, the field and the
 * house block are put together by the server and handed to the CLI as one
 * argv element. Nothing about what the seat is told travels from a browser,
 * which is the same property `/lantern/ticket` keeps, and it is also what
 * makes the role honest: only a session the server seated can carry the mark.
 *
 * POWERS ARE A SETTING, NOT A SENTENCE. A doctrine that says "do not start
 * agents" is a wish. What the seat may do is decided by `powers` on its row
 * and enforced where the verb is served — the same lesson `refusedArg` in
 * agentops.ts learned about permission flags arriving as parameters.
 */
import * as AgentOps from "./agentops.ts";
import type * as AgentBoard from "./agentboard.ts";
import { mintSeatToken, revokeSeatTokens } from "./auth.ts";
import { claudeModels } from "./claudemodels.ts";
import { chatBypassAllowed, inScope, workspaceRoot } from "./config.ts";
import { db } from "./db.ts";
import { fieldReadout, boardNow } from "./lantern.ts";
import { knownProjects } from "./transcripts.ts";
import { doctrinePath, doctrineSlug, readDoctrine } from "./seatdoctrine.ts";
import { REPORT_SHAPE, briefPath, readBrief } from "./seatbrief.ts";
import { SEAT_PROMPT_MARK } from "./seatmark.ts";
import { queueReadout } from "./seatqueue.ts";
import { inboxReadout, recentReports, unreadCount, type SeatReport } from "./seatreport.ts";
import { BUCKETS, pulses } from "./seatpulse.ts";
import { lastWoken } from "./seatwoken.ts";

/** What a seat is allowed to do. Ordered: each level is the one before it
 *  plus one verb, so a check is a comparison and not a set membership. */
/**
 * What a seat costs when nobody chose.
 *
 * Not a hard-coded id: the catalogue this app ships moves, and a constant that
 * names a model the catalogue no longer offers puts "(not in this list)" next
 * to the default in the picker — measured, on the first build that had one.
 * So it is a PREFERENCE, resolved against whatever is offered today: the
 * cheapest capable tier first, because a seat reads a board and writes a
 * sentence a few times an hour and is not the model you sit in front of.
 *
 * An empty answer is allowed and means "let the CLI decide", which is the only
 * honest thing to say when the catalogue is empty.
 */
const SEAT_MODEL_PREFERENCE = [/fable/i, /haiku/i, /sonnet/i];

export function defaultSeatModel(offered = claudeModels().map((m) => m.id)): string {
  for (const want of SEAT_MODEL_PREFERENCE) {
    const hit = offered.find((id) => want.test(id) && !id.includes("["));
    if (hit) return hit;
  }
  return offered[0] ?? "";
}

export const POWERS = ["speak", "nudge", "assign"] as const;
export type Power = (typeof POWERS)[number];
export const isPower = (s: unknown): s is Power => typeof s === "string" && (POWERS as readonly string[]).includes(s);
export const powerAtLeast = (have: Power, want: Power): boolean => POWERS.indexOf(have) >= POWERS.indexOf(want);

export interface Seat {
  root: string;
  name: string;
  kind: string;
  model: string;
  powers: Power;
  startedAt: number;
  endedAt: number | null;
  lastLine: string;
  lastTurnAt: number;
  /** Set when the seat is a session that was ALREADY running and adopted it,
   *  rather than one this app opened. Liveness is still the pane. */
  adoptedSession: string;
  adoptedPane: string;
}

interface Row {
  root: string; name: string; kind: string; model: string; powers: string;
  started_at: number; ended_at: number | null; last_line: string; last_turn_at: number;
  adopted_session: string; adopted_pane: string;
}

const toSeat = (r: Row): Seat => ({
  root: r.root, name: r.name, kind: r.kind, model: r.model,
  powers: isPower(r.powers) ? r.powers : "speak",
  startedAt: r.started_at, endedAt: r.ended_at,
  lastLine: r.last_line, lastTurnAt: r.last_turn_at,
  adoptedSession: r.adopted_session ?? "", adoptedPane: r.adopted_pane ?? "",
});

const one = db.query<Row, [string]>(`SELECT * FROM seat WHERE root = ?`);
const all = db.query<Row, []>(`SELECT * FROM seat ORDER BY root`);
const upsert = db.query<never, [string, string, string, string, string, number]>(`
  INSERT INTO seat (root, name, kind, model, powers, started_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(root) DO UPDATE SET
    name = excluded.name, kind = excluded.kind, model = excluded.model,
    powers = excluded.powers, started_at = excluded.started_at, ended_at = NULL
`);
/* Settings without a seating: the row is created idle (`started_at = 0`) so a
   person can set the powers and the model BEFORE ever opening the chair, and
   the seating reads them back instead of asking again. */
const settings = db.query<never, [string, string, string, string]>(`
  INSERT INTO seat (root, name, model, powers, started_at, ended_at)
  VALUES (?, ?, ?, ?, 0, 0)
  ON CONFLICT(root) DO UPDATE SET model = excluded.model, powers = excluded.powers
`);
const closeRow = db.query<never, [number, string]>(`UPDATE seat SET ended_at = ? WHERE root = ?`);
const adoptRow = db.query<never, [string, string, string, string, string, number]>(`
  INSERT INTO seat (root, name, powers, adopted_session, adopted_pane, started_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(root) DO UPDATE SET
    adopted_session = excluded.adopted_session, adopted_pane = excluded.adopted_pane,
    started_at = excluded.started_at, ended_at = NULL
`);
const unadopt = db.query<never, [string]>(`UPDATE seat SET adopted_session = '', adopted_pane = '' WHERE root = ?`);
const saidRow = db.query<never, [string, number, string]>(`UPDATE seat SET last_line = ?, last_turn_at = ? WHERE root = ?`);
/* Every line, not only the latest. The row keeps the last one because the
   header reads it on every poll and a join for one string is a join too many;
   this is the day. */
const keepLine = db.query<never, [string, string, number]>(`INSERT INTO seat_line (root, line, at) VALUES (?, ?, ?)`);
const recentLines = db.query<{ line: string; at: number }, [string, number]>(
  `SELECT line, at FROM seat_line WHERE root = ? ORDER BY at DESC LIMIT ?`);

/**
 * The name the seat's window carries.
 *
 * It has to be unique per project — two seats on one machine would otherwise
 * fight over one `named_agent` row — and it has to survive `NAME_RE`, so the
 * path's hash rides along rather than the path.
 */
export function seatName(root: string): string {
  return `orchestrator-${doctrineSlug(root).slice(0, 40)}`;
}

/** The row for a project, whether or not it is seated. */
export function seatRow(root: string): Seat | null {
  const r = one.get(root);
  return r ? toSeat(r) : null;
}

export function everySeat(): Seat[] { return all.all().map(toSeat); }

/**
 * A root a seat may be opened at, or a refusal.
 *
 * Every other route that takes a directory measures it against the OPEN
 * project (`inScope`). A seat cannot: the whole point of one seat per project
 * is that the seat for a repository you are not looking at right now keeps
 * running. So the gate is the project list this app already serves at
 * `/projects` — a root it has never seen is refused, and the widening stops
 * exactly there.
 */
export function seatable(rootIn: unknown): { root: string } | { error: string } {
  const root = typeof rootIn === "string" ? rootIn.trim() : "";
  if (!root) return { error: "no project given" };
  if (!root.startsWith("/") || root.includes("\0")) return { error: "not an absolute path" };
  /* The OPEN project always qualifies, and it has to: `knownProjects()` is
     built from sessions this app has seen, so on a fresh install it is empty
     — and the first thing a person does is open the view for the project they
     are looking at. Measured by running it: without this line a new install
     answered "that is not a project this app knows" about its own checkout. */
  if (root === workspaceRoot()) return { root };
  const known = knownProjects().some((p) => p.path === root);
  if (!known) return { error: "that is not a project this app knows" };
  return { root };
}

/**
 * Whether an agent is in the chair right now — the pane, never the row.
 *
 * Two ways to be in it, one answer. A seat this app opened is a named agent
 * and `reconcile` closes it the moment its pane is gone. A seat that was
 * ADOPTED is a session that was already working when the chair was built: its
 * pane is checked the same way, so an adopted orchestrator that dies stops
 * being the orchestrator exactly as fast as one this app started.
 */
export async function seated(root: string): Promise<AgentOps.NamedAgent | null> {
  const name = seatName(root);
  await AgentOps.reconcile();
  const a = AgentOps.agentNamed(name);
  if (a && a.endedAt === null) return a;

  const row = seatRow(root);
  if (!row?.adoptedPane) return null;
  const alive = await AgentOps.paneAlive(row.adoptedPane);
  if (!alive) {
    /* Its pane is gone. The row keeps its settings and its lines; what it
       stops claiming is that somebody is sitting there. */
    unadopt.run(root);
    return null;
  }
  return {
    name: row.name || "orchestrator", kind: row.kind || "claude", cwd: root,
    paneId: row.adoptedPane, windowId: "", startedAt: row.startedAt, endedAt: null,
  };
}

/**
 * Adopt a session that is already orchestrating this project.
 *
 * Nothing is restarted, nothing is re-prompted, and no context is thrown away:
 * the whole point is the orchestrator that has been running for a day with
 * five agents reporting to it. What it gains is the app knowing who it is —
 * its line in the view, its queue, the field drawn for it, and being woken
 * when that field changes instead of keeping a clock of its own.
 *
 * Its rules are NOT rewritten either. The two files are seeded if missing so
 * there is something to edit, and an adopted seat is told where they are
 * rather than handed them.
 */
export async function adoptSeat(p: { root: string; session: string; pane: string; powers?: Power; now?: number }):
Promise<{ ok: true; seat: Seat; already: boolean } | { ok: false; error: string }> {
  const gate = seatable(p.root);
  if ("error" in gate) return { ok: false, error: gate.error };
  const pane = String(p.pane ?? "").trim();
  if (!/^%\d+$/.test(pane)) return { ok: false, error: "a pane id looks like %12" };
  if (!(await AgentOps.paneAlive(pane))) return { ok: false, error: "there is no such pane on this machine's engine" };

  const there = await seated(gate.root);
  if (there && there.paneId !== pane) {
    return { ok: false, error: `${there.name} is already in this project's chair; stand it down first` };
  }
  const row = seatRow(gate.root);
  adoptRow.run(
    gate.root,
    row?.name || seatName(gate.root),
    p.powers ?? row?.powers ?? "speak",
    String(p.session ?? ""),
    pane,
    p.now ?? Date.now(),
  );
  return { ok: true, seat: seatRow(gate.root)!, already: there !== null };
}

/**
 * The house block: what the SERVER tells every seat, under whatever the
 * doctrine says.
 *
 * It is separate from the doctrine because these are not house rules a person
 * should have to keep re-typing, and because two of them stop the seat from
 * wasting a turn: it must not build its own clock (the app already re-reads
 * the field and will wake it when something changes), and it must report
 * through one line rather than leave a person to read a pane.
 */
export function houseBlock(powers: Power, wakeHours: number, root = ""): string {
  const may = powers === "speak"
    ? "You may not start, stop or prompt any agent. If one is stuck, say so — do not push it."
    : powers === "nudge"
      ? "You may prompt an agent that is ALREADY running, to unstick it (`agentglass-agent prompt --name <n> \"…\"`). You may not start or stop one."
      : [
        "You may prompt an agent that is already running, and start or stop named agents (`agentglass-agent start|prompt|stop`).",
        `When you OPEN one, its first message is this project's worker brief — the file beside your rules — and nothing else you write replaces it: \`claude --dangerously-skip-permissions "$(cat ${root ? briefPath(root) : "the brief file beside your rules"})"\`, or \`agentglass-agent start <name> --cwd <checkout> --yolo\` and then send it. Every agent gets the same rules, which is what makes their reports comparable.`,
        `Ask for the report in one shape and no other: ${REPORT_SHAPE}. A report you have to read twice is a report that cost twice.`,
        "- One message to many: `agentglass-agent broadcast \"…\"` sends to every named agent, or `--to a,b,c` to some. Every name's outcome comes back, so a send that reached four of five is not read as five.",
        "- Their reports arrive in a tray, not in your context. `agentglass-agent inbox` hands you everything unread in one call and marks it read; you are woken when one arrives.",
        "When you hand a queued item to an agent, claim it first — `agentglass-agent claim <task-id> --to <agent-name>` — and say how it went with `agentglass-agent finish <task-id> \"<outcome>\"`.",
        "An item this app says has been beaten twice is NOT to be handed out again: say it needs a person.",
      ].join(" ");
  return [
    "",
    "## How this app works with you",
    "",
    /*
     * The three rules every published orchestrator converged on, and none of
     * them were ours: the bank before the opinion, evidence instead of prose,
     * and absence as a checkpoint rather than an answer. Orca's skill states
     * the third best — "a timeout or empty result is a checkpoint, not a
     * failure" — and the failure it prevents is the one people report most:
     * a worker killed mid-task reports as completed, with no deliverable.
     */
    "- BEFORE you propose, queue or decide anything, ask what this person already decided: `agentglass-agent recall \"<the question, in your words>\"`. It answers out of thousands of recorded decisions, and it says when it has nothing — then decide on the facts and say you had no precedent.",
    "- \"Done\" is evidence YOU observed: a commit that exists, a diff, a test run you read. Never an agent's own word for it, and never prose where a fact belongs. What you did not verify, you report as unverified.",
    "- Silence is not an answer. An agent that has not replied is neither finished nor failed — it is unknown. Never conclude, retry, or hand its work to somebody else on a timeout alone: say it is unknown, and if it stays unknown say it needs a person.",
    "- Report each round by running `agentglass-agent say` from this checkout with YOUR sentence as its one argument — never the words below, which are only the shape:",
    "    agentglass-agent say \"2 stopped on you: db-fix wants permission (12m), tab-strip quiet 1h. 3 moving.\"",
    "  That sentence is what a person reads in the Orchestrator view; nothing else you print reaches them.",
    `- ${may}`,
    "- You never merge, never push, and never open a pull request. When something is ready you say it is ready and who it is ready for.",
    `- DO NOT build a loop or a schedule of your own. This app re-reads the field on its own clock and will prompt you when something changes, and at least every ${wakeHours} h if nothing does. A round you run for yourself is a round nobody asked for.`,
    "- End your round after you have reported. Waiting costs a turn; being woken costs nothing.",
    "",
  ].join("\n");
}

/**
 * The field, narrowed to one project.
 *
 * The board is machine-wide, and the seat is not: an orchestrator for one
 * repository being handed every agent on the laptop would report on work that
 * is none of its business and, worse, offer to unstick it. A row belongs to
 * this project when its checkout does — measured with `inScope`, which knows
 * the worktree FAMILY, because the worktrees of a project are siblings of its
 * root and not children of it (`~/code/orbit-ORBIT-1042` next to `~/code/orbit`).
 *
 * A row with no checkout at all is left OUT rather than guessed in: a screen
 * that guesses is a screen that lies, and the cost of leaving one out is that
 * the seat does not mention it, while the cost of guessing it in is the seat
 * prompting somebody else's agent.
 */
export function fieldFor(root: string, rows: AgentBoard.BoardRow[]): AgentBoard.BoardRow[] {
  return rows.filter((r) => r.worktree && inScope(r.worktree, root));
}

/** Doctrine + field + house block, in the order the seat reads them. */
export async function seatPrompt(root: string, powers: Power, wakeHours: number): Promise<{ prompt: string; doctrine: string }> {
  const { text } = readDoctrine(root);
  const rows = fieldFor(root, await boardNow().catch(() => []));
  const prompt = [
    `${SEAT_PROMPT_MARK}: ${root}.`,
    "",
    text.trim(),
    houseBlock(powers, wakeHours, root),
    `## The agents working in ${root} right now`,
    "",
    fieldReadout(rows),
    "",
    /* The queue rides in the prompt rather than being fetched: the seat is
       woken with a message, and a round that begins by asking the server what
       it already knows spends a tool call on a list this app can just hand
       over. */
    "## Reports waiting for you",
    "",
    inboxReadout(root),
    "",
    "## The queue for this project",
    "",
    queueReadout(root),
    "",
    "Begin: one line saying who needs a person and what everybody else is on.",
  ].join("\n");
  return { prompt, doctrine: text };
}

export type OpenResult =
  | { ok: true; seat: Seat; agent: AgentOps.NamedAgent; already: boolean }
  | { ok: false; error: string };

/**
 * Open the seat for a project, or bring the one that is there.
 *
 * Seating twice is the common accident — a person presses the button, nothing
 * seems to happen because the window is not on screen, and they press it
 * again. A second agent under one name would leave one of them unreachable,
 * so an occupied chair answers with its occupant rather than a failure.
 */
export async function openSeat(p: {
  root: string; model?: string; powers?: Power; kind?: string; wakeHours?: number; now?: number;
}): Promise<OpenResult> {
  const gate = seatable(p.root);
  if ("error" in gate) return { ok: false, error: gate.error };
  const root = gate.root;
  const there = await seated(root);
  const row = seatRow(root);
  if (there) return { ok: true, seat: row ?? toSeat({ root, name: there.name, kind: there.kind, model: "", powers: "speak", started_at: there.startedAt, ended_at: null, last_line: "", last_turn_at: 0, adopted_session: "", adopted_pane: "" }), agent: there, already: true };

  const powers: Power = p.powers ?? row?.powers ?? "speak";
  /* A seat reads a board and writes a sentence a few times an hour. It is not
     the model you sit in front of, and left to the CLI's default it would be
     the most expensive one on the machine — so the default is named here, and
     a person can change it. */
  /* `||`, not `??`: a row written by the settings route carries "" for "not
     chosen", and an empty string is not nullish — with `??` the default below
     would be skipped and the CLI would fall back to the most expensive model
     on the machine. */
  const model = p.model || row?.model || defaultSeatModel();
  const kind = p.kind ?? row?.kind ?? "claude";
  const { prompt } = await seatPrompt(root, powers, p.wakeHours ?? 4);
  const name = seatName(root);
  /*
   * Its own credential, not the machine's.
   *
   * An agent this server starts inherits the environment, and the machine
   * token is in it — so without this the seat would ask as the machine, with
   * `full` scope, and `powers` would be a sentence in a prompt rather than a
   * wall. The token is minted here, carried in the window's environment (which
   * `AGENTGLASS_TOKEN` takes precedence over the token file for), and revoked
   * when the chair is emptied.
   */
  revokeSeatTokens(root);
  const token = mintSeatToken(root, powers);
  const r = await AgentOps.startAgent({
    root, name, cwd: root, kind, prompt,
    yolo: true, yoloAllowed: chatBypassAllowed(),
    args: model ? ["--model", model] : [],
    env: { AGENTGLASS_TOKEN: token, AGENTGLASS_SEAT: root },
    now: p.now,
  });
  if (!r.ok) {
    revokeSeatTokens(root);
    const why: Record<string, string> = {
      exists: "an agent is already running under the seat's name",
      "no-cli": "that agent CLI is not installed here",
      "no-window": "tmux would not open a window for the seat",
      "bad-name": "the seat's name is not one tmux can carry",
      "yolo-refused": "the seat runs unattended, and skipping permissions is off in Settings",
      "bad-args": "the model must be a plain string",
      "arg-refused": "that model flag changes what the agent may do",
    };
    return { ok: false, error: why[r.error] ?? r.error };
  }
  upsert.run(root, name, kind, model, powers, r.agent.startedAt);
  return { ok: true, seat: seatRow(root)!, agent: r.agent, already: false };
}

/** Empty the chair. The row stays: its settings and its last line are what the
 *  next seating starts from. */
export async function closeSeat(root: string, now = Date.now()): Promise<{ ok: boolean; was: boolean }> {
  const row = seatRow(root);
  const there = await seated(root);
  closeRow.run(now, root);
  revokeSeatTokens(root);
  if (!there) return { ok: true, was: false };
  /* An ADOPTED seat is somebody else's session doing its own work. Standing it
     down means this app stops calling it the orchestrator; killing it would be
     killing a day of somebody's context because a button said "stand down". */
  if (row?.adoptedPane && there.paneId === row.adoptedPane) {
    unadopt.run(root);
    return { ok: true, was: true };
  }
  await AgentOps.stopAgent(there, now);
  return { ok: true, was: true };
}

/** The seat's one line per round. */
export function seatSays(root: string, line: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  const text = String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return { ok: false, error: "nothing said" };
  if (!seatRow(root)) return { ok: false, error: "no seat for that project" };
  saidRow.run(text, now, root);
  keepLine.run(root, text, now);
  return { ok: true };
}

/** What it said, newest first. The view's "its day". */
export function seatLines(root: string, limit = 8): { line: string; at: number }[] {
  return recentLines.all(root, Math.max(1, Math.min(50, limit)));
}

/** Change what a seat is worth paying for and what it may do, seated or not.
 *  Takes effect on the NEXT seating: a prompt already handed to a running CLI
 *  cannot be edited, and pretending otherwise would be a setting that lies. */
export function setSeatSettings(root: string, model: string, powers: Power): void {
  settings.run(root, seatName(root), model, powers);
}

/**
 * WHAT THE SEAT IS DOING, cut out of its pane.
 *
 * The first version showed the last few non-empty lines, which on a Claude
 * pane is the input box, the status line and whatever a hook printed —
 * "MEMORY REMINDER", a spinner, an empty prompt. Everything except the thing
 * a person opened this to see. Measured on a real one: eight lines of chrome
 * and not one of work.
 *
 * So: cut at the input box (its glyph is the CLI's own, the same one
 * chatpane.ts waits on) and keep what is ABOVE it, which is what the agent
 * last did. Drop the hook chatter and the spinner rows, because they are the
 * app talking to itself rather than the agent working. If nothing survives,
 * say nothing: an empty box is more honest than a box full of furniture, and
 * the view does not draw one.
 */
export function shoulder(screen: string): string {
  if (!screen.trim()) return "";
  const lines = screen.split("\n");
  /* The LAST box, not the first: a transcript can quote one. */
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[❯>]\s/.test(lines[i]!)) { cut = i; break; }
  const NOISE = [
    /UserPromptSubmit says:/i,
    /MEMORY REMINDER/i,
    /^\s*[·*✻✽✢✳✶]?\s*\w+…\s*\(\d+s/,     /* the spinner and its counter */
    /^\s*⏵⏵/,                                  /* the permission-mode footer */
    /^\s*⎿?\s*Tip:/,                           /* the CLI's own advice to its user */
    /^\s*⎿?\s*\[Image #\d+\]\s*$/,             /* a picture's placeholder: the pane
                                                  drew it, a text capture cannot */
    /shift\+tab to cycle/i,
    /^\s*[─━┄┈]{3,}/,                          /* the rules the TUI draws, and the
                                                  one carrying the pane's own name
                                                  at the end of it */
    /^\s*╭|^\s*╰|^\s*│\s*$/,                 /* the box it draws them in */
  ];
  const kept = lines.slice(0, cut)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !NOISE.some((re) => re.test(l)));
  return kept.slice(-6).join("\n");
}

/** One row of the field, as the view draws it: who, what state, and the last
 *  hour of what they actually did. */
export interface FieldRow {
  name: string;
  session?: string;
  paneId?: string;
  state: "working" | "waiting" | "idle";
  needsYou?: { kind: string; why: string; since: number };
  doing?: string;
  saidAt?: number;
  /** Twelve five-minute counts, oldest first. */
  pulse: number[];
}

/** Everything the view needs for one project, in one answer. */
export async function seatStatus(root: string): Promise<{
  root: string; doctrine: string; seat: Seat | null; agent: AgentOps.NamedAgent | null; live: boolean;
  field: FieldRow[]; wokenAt: number | null; screen: string; unread: number; reports: SeatReport[];
  brief: string; briefText: string;
}> {
  const agent = await seated(root);
  const screen = shoulder(agent ? (await AgentOps.screenOf(agent.paneId, 60).catch(() => null)) ?? "" : "");
  const rows = fieldFor(root, await boardNow().catch(() => []));
  const pulse = pulses(rows.map((r) => r.session ?? ""));
  const field: FieldRow[] = rows.map((r) => ({
    name: r.name,
    session: r.session,
    paneId: r.paneId,
    state: r.state,
    needsYou: r.needsYou,
    doing: r.doing,
    saidAt: r.saidAt,
    pulse: pulse.get(r.session ?? "") ?? new Array(BUCKETS).fill(0),
  }));
  return {
    root, doctrine: doctrinePath(root), seat: seatRow(root), agent, live: agent !== null,
    field, wokenAt: lastWoken(root), screen, unread: unreadCount(root),
    /*
     * THE TRAY IS THE SEAT'S, AND THIS IS A WINDOW ONTO IT.
     *
     * Recent, not unread, and nothing here marks anything read: draining is
     * how the seat learns what its agents said, and a person clearing the tray
     * from a screen would take a report the seat never got to see. So the view
     * reads over its shoulder and leaves the post alone.
     */
    reports: recentReports(root, 8),
    brief: briefPath(root), briefText: readBrief(root).text,
  };
}
