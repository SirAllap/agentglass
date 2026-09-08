/*
 * THE INBOX — reports from the agents doing the work, in the shape the brief
 * asks for.
 *
 * The orchestrator this was modelled on had one thing at the top of its list:
 * a tray where each agent's report arrives in the fixed format without it
 * having to paste them five times. Today a worker messages the seat and the
 * report lands as prose in the most expensive context on the machine, which is
 * exactly the cost that made it demand a fixed shape in the first place — its
 * first round of statuses came back forty lines per agent.
 *
 * So a report is a ROW with four fields, and the seat drains them in one call.
 *
 * PARSED, NOT DEMANDED. An agent that writes the four labels gets four fields;
 * one that writes a paragraph gets that paragraph as its state and nothing is
 * lost. A parser that refuses a report is a parser that turns a status into an
 * argument about formatting, and the report is the thing that matters.
 */
import { db } from "./db.ts";

export interface SeatReport {
  id: number;
  root: string;
  agent: string;
  session: string;
  state: string;
  blocked: string;
  need: string;
  cost: string;
  raw: string;
  at: number;
  readAt: number | null;
}

interface Row {
  id: number; root: string; agent: string; session: string;
  state: string; blocked: string; need: string; cost: string; raw: string;
  at: number; read_at: number | null;
}

const toReport = (r: Row): SeatReport => ({
  id: r.id, root: r.root, agent: r.agent, session: r.session,
  state: r.state, blocked: r.blocked, need: r.need, cost: r.cost, raw: r.raw,
  at: r.at, readAt: r.read_at,
});

const insert = db.query<never, [string, string, string, string, string, string, string, string, number]>(`
  INSERT INTO seat_report (root, agent, session, state, blocked, need, cost, raw, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const unreadQ = db.query<Row, [string, number]>(
  `SELECT * FROM seat_report WHERE root = ? AND read_at IS NULL ORDER BY at ASC LIMIT ?`);
const recentQ = db.query<Row, [string, number]>(
  `SELECT * FROM seat_report WHERE root = ? ORDER BY at DESC LIMIT ?`);
const markQ = db.query<never, [number, string]>(
  `UPDATE seat_report SET read_at = ? WHERE root = ? AND read_at IS NULL`);
const countQ = db.query<{ n: number }, [string]>(
  `SELECT COUNT(*) AS n FROM seat_report WHERE root = ? AND read_at IS NULL`);

const line = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Pull the four fields out of whatever an agent sent.
 *
 * The labels are matched loosely on purpose — an agent writing in its own
 * language, or with a colon, a dash or nothing after the word, still lands in
 * the right field. Anything before the first label is the state, because a
 * report that opens with a sentence and then labels the rest is the common
 * shape and dropping that sentence would drop the answer.
 */
export function parseReport(text: string): { state: string; blocked: string; need: string; cost: string } {
  const raw = String(text ?? "");
  /* Two details that are only obvious once they bite:
     the bold markers sit on EITHER side of the separator — `**STATE**:` and
     `**STATE:**` are both things people write — so both positions are optional;
     and the word ends where the word ends, or `COSTE` matches the `cost` arm
     and leaves an `E` at the head of the value. */
  const LABEL = /^\s*(?:\*\*)?\s*(state|estado|blocked|bloqueo|bloqueado|need|necesito|necesita|coste|costo|cost)\b\s*(?:\*\*)?\s*[:\-–—]?\s*(?:\*\*)?\s*/i;
  const bucket: Record<string, string[]> = { state: [], blocked: [], need: [], cost: [] };
  const key = (w: string) => {
    const l = w.toLowerCase();
    if (l.startsWith("est") || l === "state") return "state";
    if (l.startsWith("bloq") || l === "blocked") return "blocked";
    if (l.startsWith("nece") || l === "need") return "need";
    return "cost";
  };
  let where = "state";
  for (const ln of raw.split("\n")) {
    const m = LABEL.exec(ln);
    if (m) { where = key(m[1]!); bucket[where]!.push(ln.slice(m[0].length)); continue; }
    bucket[where]!.push(ln);
  }
  const join = (k: string) => line(bucket[k]!.join(" ")).slice(0, 600);
  return { state: join("state"), blocked: join("blocked"), need: join("need"), cost: join("cost") };
}

export function addReport(p: { root: string; agent: string; session?: string; text: string; now?: number }):
{ ok: true; report: SeatReport } | { ok: false; error: string } {
  const agent = line(p.agent).slice(0, 80);
  if (!agent) return { ok: false, error: "a report says who it is from" };
  const raw = String(p.text ?? "").slice(0, 8000);
  if (!raw.trim()) return { ok: false, error: "an empty report is not a report" };
  const f = parseReport(raw);
  const at = p.now ?? Date.now();
  insert.run(p.root, agent, line(p.session ?? ""), f.state, f.blocked, f.need, f.cost, raw, at);
  const [last] = recentQ.all(p.root, 1);
  return { ok: true, report: toReport(last!) };
}

export const unreadReports = (root: string, limit = 20): SeatReport[] => unreadQ.all(root, Math.max(1, Math.min(100, limit))).map(toReport);
export const recentReports = (root: string, limit = 8): SeatReport[] => recentQ.all(root, Math.max(1, Math.min(100, limit))).map(toReport);
export const unreadCount = (root: string): number => countQ.get(root)?.n ?? 0;

/** Everything unread, and it is read now. One call, which is the whole ask. */
export function drainReports(root: string, now = Date.now()): SeatReport[] {
  const out = unreadReports(root, 100);
  if (out.length) markQ.run(now, root);
  return out;
}

/** The inbox as the seat reads it in its prompt: who said what, shortest
 *  first-useful order — anybody blocked or needing something, then the rest. */
export function inboxReadout(root: string): string {
  const rs = unreadReports(root, 20);
  if (!rs.length) return "No unread reports.";
  const urgent = rs.filter((r) => r.blocked || r.need);
  const rest = rs.filter((r) => !r.blocked && !r.need);
  const one = (r: SeatReport) => [
    `- ${r.agent}: ${r.state || "(said nothing about its state)"}`,
    r.blocked ? `    blocked: ${r.blocked}` : "",
    r.need ? `    needs: ${r.need}` : "",
    r.cost ? `    cost: ${r.cost}` : "",
  ].filter(Boolean).join("\n");
  const out: string[] = [];
  if (urgent.length) out.push(`${urgent.length} of them are stopped or need something:`, ...urgent.map(one));
  if (rest.length) out.push(urgent.length ? "" : `${rest.length} reports:`, ...rest.map(one));
  return out.join("\n");
}
