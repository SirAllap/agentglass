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
import { chatBypassAllowed } from "./config.ts";
import { db } from "./db.ts";
import { fieldReadout, boardNow } from "./lantern.ts";
import { knownProjects } from "./transcripts.ts";
import { doctrinePath, readDoctrine } from "./seatdoctrine.ts";
import { doctrineSlug } from "./seatdoctrine.ts";
import { SEAT_PROMPT_MARK } from "./seatmark.ts";

/** What a seat is allowed to do. Ordered: each level is the one before it
 *  plus one verb, so a check is a comparison and not a set membership. */
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
}

interface Row {
  root: string; name: string; kind: string; model: string; powers: string;
  started_at: number; ended_at: number | null; last_line: string; last_turn_at: number;
}

const toSeat = (r: Row): Seat => ({
  root: r.root, name: r.name, kind: r.kind, model: r.model,
  powers: isPower(r.powers) ? r.powers : "speak",
  startedAt: r.started_at, endedAt: r.ended_at,
  lastLine: r.last_line, lastTurnAt: r.last_turn_at,
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
const saidRow = db.query<never, [string, number, string]>(`UPDATE seat SET last_line = ?, last_turn_at = ? WHERE root = ?`);

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
  const known = knownProjects().some((p) => p.path === root);
  if (!known) return { error: "that is not a project this app knows" };
  return { root };
}

/** Whether an agent is in the chair right now — the pane, never the row. */
export async function seated(root: string): Promise<AgentOps.NamedAgent | null> {
  const name = seatName(root);
  await AgentOps.reconcile();
  const a = AgentOps.agentNamed(name);
  return a && a.endedAt === null ? a : null;
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
export function houseBlock(powers: Power, wakeHours: number): string {
  const may = powers === "speak"
    ? "You may not start, stop or prompt any agent. If one is stuck, say so — do not push it."
    : powers === "nudge"
      ? "You may prompt an agent that is ALREADY running, to unstick it (`agentglass-agent prompt --name <n> \"…\"`). You may not start or stop one."
      : "You may prompt an agent that is already running, and start or stop named agents on the queue (`agentglass-agent start|prompt|stop`).";
  return [
    "",
    "## How this app works with you",
    "",
    `- Report each round with ONE line: \`agentglass-seat say \"<the line>\"\`. That line is what the person sees in the Orchestrator view; nothing else you print reaches them.`,
    `- ${may}`,
    "- You never merge, never push, and never open a pull request. When something is ready you say it is ready and who it is ready for.",
    `- DO NOT build a loop or a schedule of your own. This app re-reads the field on its own clock and will prompt you when something changes, and at least every ${wakeHours} h if nothing does. A round you run for yourself is a round nobody asked for.`,
    "- End your round after you have reported. Waiting costs a turn; being woken costs nothing.",
    "",
  ].join("\n");
}

/** Doctrine + field + house block, in the order the seat reads them. */
export async function seatPrompt(root: string, powers: Power, wakeHours: number): Promise<{ prompt: string; doctrine: string }> {
  const { text } = readDoctrine(root);
  const rows = await boardNow().catch(() => []);
  const prompt = [
    `${SEAT_PROMPT_MARK}: ${root}.`,
    "",
    text.trim(),
    houseBlock(powers, wakeHours),
    "## The field as it is right now",
    "",
    fieldReadout(rows),
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
  if (there) return { ok: true, seat: row ?? toSeat({ root, name: there.name, kind: there.kind, model: "", powers: "speak", started_at: there.startedAt, ended_at: null, last_line: "", last_turn_at: 0 }), agent: there, already: true };

  const powers: Power = p.powers ?? row?.powers ?? "speak";
  const model = p.model ?? row?.model ?? "";
  const kind = p.kind ?? row?.kind ?? "claude";
  const { prompt } = await seatPrompt(root, powers, p.wakeHours ?? 4);
  const name = seatName(root);
  const r = await AgentOps.startAgent({
    root, name, cwd: root, kind, prompt,
    yolo: true, yoloAllowed: chatBypassAllowed(),
    args: model ? ["--model", model] : [],
    now: p.now,
  });
  if (!r.ok) {
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
  const there = await seated(root);
  closeRow.run(now, root);
  if (!there) return { ok: true, was: false };
  await AgentOps.stopAgent(there.name);
  return { ok: true, was: true };
}

/** The seat's one line per round. */
export function seatSays(root: string, line: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  const text = String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return { ok: false, error: "nothing said" };
  if (!seatRow(root)) return { ok: false, error: "no seat for that project" };
  saidRow.run(text, now, root);
  return { ok: true };
}

/** Change what a seat is worth paying for and what it may do, seated or not. */
export function setSeatSettings(root: string, model: string, powers: Power): void {
  const existing = seatRow(root);
  if (existing) setSettings.run(seatName(root), model, powers);
  else upsertIdle(root, model, powers);
}

const upsertIdle = (root: string, model: string, powers: Power): void => {
  db.query("INSERT INTO seat (root, name, model, powers, started_at, ended_at) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(root) DO NOTHING")
    .run(root, seatName(root), model, powers);
};

/** Everything the view needs for one project, in one answer. */
export async function seatStatus(root: string): Promise<{
  root: string; doctrine: string; seat: Seat | null; agent: AgentOps.NamedAgent | null; live: boolean;
}> {
  const agent = await seated(root);
  return { root, doctrine: doctrinePath(root), seat: seatRow(root), agent, live: agent !== null };
}
