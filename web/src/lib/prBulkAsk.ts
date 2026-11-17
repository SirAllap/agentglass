/*
 * The PR board's bulk "Request review…", as decisions with no React in them.
 *
 * One reviewer for every picked pull request, and, where a picked one has a task linked in a connected task tool,
 * the same two moves the one-PR picker (PrAskPicker.tsx) makes on that task: put the same person on it, and move it.
 * Nothing here is new policy. The rules are today's:
 *
 * - GitHub never asks a login twice and never asks the author (lib/prHandOver.ts `already`, `withoutAuthor`).
 * - The task tool is named from the link (`SYSTEM_NAME`), and only ClickUp has defaults (Settings ▸ ClickUp ▸ review
 *   step); Jira starts with both switches off.
 * - "Same person" needs the login linked to an account in that tool, as the one-PR picker's link rows do.
 * - A tool whose writes are off says so and writes nothing; a task that cannot make the move is skipped, never forced.
 * - GitHub first, then the tasks; a failure says what is already done; Retry sends only what failed. No undo.
 *
 * The plan is built per pull request (`bulkPlan`), said as one line before anything is written (`bulkSummary`), run
 * with injected writers (`runBulk`, so tests use fakes and never GitHub or a tracker), and reported one row per pull
 * request (`bulkRows`). Tested in web/test/pr-bulk-ask.test.ts.
 */
import type { TrackerKind } from "./prHandOver.ts";

export const TOOL_NAME: Record<TrackerKind, string> = { clickup: "ClickUp", jira: "Jira" };

const lc = (s: string) => s.trim().toLowerCase();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The task a picked pull request links to, as far as the board knows it. */
export interface BulkTask {
  kind: TrackerKind;
  /** `ORBIT-1042`, `CU-86b2x1`: what the person reads. */
  id: string;
  /** Where it is now. */
  status: string;
  /** Every status it can be moved to from here without a form (Jira: moves that need no field). Null: not read yet. */
  moves: readonly string[] | null;
  /** The link is known but the task itself is not read yet: nothing is written to it. */
  unread?: boolean;
}

export interface BulkPr {
  number: number;
  title: string;
  author: string;
  /** Logins already asked on GitHub. */
  asked: readonly string[];
  task: BulkTask | null;
}

export interface Who { login: string; name: string }

/** What the person chose for one tool's block. */
export interface ToolPick { assign: boolean; move: boolean; to: string }

/** What this machine knows about one tool for the chosen reviewer. */
export interface ToolState {
  /** The account the reviewer's login is linked to in this tool, or null: not linked yet, so no assign. */
  linked: string | null;
  /** The tool's writes are off: the sentence that says so (`JIRA_WRITES_OFF`), or null. */
  blocked: string | null;
}

export interface TaskWrite {
  kind: TrackerKind;
  id: string;
  /** Put the reviewer's linked account on it. */
  assign: boolean;
  /** Move it to this status; null leaves it. */
  to: string | null;
  /** The move was asked for but this task cannot make it from where it is: it is left where it is. */
  cant: string | null;
  /** Nothing is written to this task, and why. */
  skip: string | null;
}

export interface BulkItem {
  number: number;
  title: string;
  gh: { send: boolean; skip: string | null };
  /** Null: no linked task (or the task tool is not connected). */
  task: TaskWrite | null;
}

/** The tools the picked pull requests link to, in the order they first appear. */
export function toolsOf(prs: readonly BulkPr[]): TrackerKind[] {
  const out: TrackerKind[] = [];
  for (const p of prs) if (p.task && !out.includes(p.task.kind)) out.push(p.task.kind);
  return out;
}

/**
 * Where a tool's switches start: ClickUp follows its review step (Settings ▸ ClickUp ▸ review step), as the one-PR
 * picker does; Jira has no such setting, so both start off. `to` is the status the select shows either way.
 */
export function toolDefaults(kind: TrackerKind, o: { assignReviewer?: boolean; reviewTo?: string; offer: readonly string[] }): ToolPick {
  const to = (kind === "clickup" ? o.reviewTo : "") || o.offer[0] || "";
  if (kind === "jira") return { assign: false, move: false, to };
  return { assign: o.assignReviewer === true, move: !!o.reviewTo, to };
}

/** The statuses one tool's "Move to" offers: what the tasks offer, in their order, a review status first. */
export function moveOffer(offers: readonly (readonly string[])[], max = 5): string[] {
  const all: string[] = [];
  for (const o of offers) for (const s of o) if (!all.some((x) => lc(x) === lc(s))) all.push(s);
  const review = all.find((s) => /review/i.test(s));
  return (review ? [review, ...all.filter((s) => s !== review)] : all).slice(0, max);
}

/** Which pull request gets which writes. Built again on every change; nothing is sent from here. */
export function bulkPlan(i: {
  prs: readonly BulkPr[];
  who: Who | null;
  picks: Partial<Record<TrackerKind, ToolPick>>;
  tools: Partial<Record<TrackerKind, ToolState>>;
}): BulkItem[] {
  const { who } = i;
  return i.prs.map((p) => {
    let gh: BulkItem["gh"] = { send: false, skip: "No reviewer picked" };
    if (who) {
      if (lc(p.author) === lc(who.login)) gh = { send: false, skip: `${who.name} opened it, so cannot review it` };
      else if (p.asked.some((a) => lc(a) === lc(who.login))) gh = { send: false, skip: `${who.name} is already asked` };
      else gh = { send: true, skip: null };
    }
    const t = p.task;
    if (!t) return { number: p.number, title: p.title, gh, task: null };
    const name = TOOL_NAME[t.kind];
    const pick = i.picks[t.kind];
    const st = i.tools[t.kind];
    const base = { kind: t.kind, id: t.id, assign: false, to: null, cant: null };
    if (st?.blocked) return { number: p.number, title: p.title, gh, task: { ...base, skip: st.blocked } };
    if (t.unread) return { number: p.number, title: p.title, gh, task: { ...base, skip: `${name} ${t.id} is not read yet. Nothing is written to it.` } };
    const assign = !!who && !!pick?.assign && !!st?.linked;
    let to: string | null = pick?.move && pick.to ? pick.to : null;
    let cant: string | null = null;
    if (to && lc(to) === lc(t.status)) to = null;
    else if (to && t.moves && !t.moves.some((m) => lc(m) === lc(to!))) { cant = `${to} is not a move this card can make from here`; to = null; }
    const skip = assign || to ? null : cant ?? (pick?.move && pick.to ? `Already in ${t.status}` : `Nothing chosen for ${name}`);
    return { number: p.number, title: p.title, gh, task: { ...base, assign, to, cant, skip } };
  });
}

/** "5 pull requests · reviewer Sam Acme · 4 Jira tasks assigned and moved to Code review"; null until a reviewer is picked. */
export function bulkSummary(items: readonly BulkItem[], who: Who | null): string | null {
  if (!who) return null;
  const parts = [plural(items.length, "pull request"), `reviewer ${who.name}`];
  const tasks = items.flatMap((x) => (x.task ? [x.task] : []));
  for (const kind of [...new Set(tasks.map((t) => t.kind))]) {
    const ts = tasks.filter((t) => t.kind === kind);
    const w = `${TOOL_NAME[kind]} task`;
    const na = ts.filter((t) => t.assign).length;
    const moved = ts.filter((t) => t.to);
    const nm = moved.length;
    const tos = [...new Set(moved.map((t) => t.to!))];
    const to = tos.length === 1 ? tos[0]! : "the chosen status";
    if (na && na === nm && ts.every((t) => t.assign === !!t.to)) parts.push(`${plural(na, w)} assigned and moved to ${to}`);
    else {
      if (na) parts.push(`${plural(na, w)} assigned`);
      if (nm) parts.push(`${plural(nm, w)} moved to ${to}`);
    }
  }
  return parts.join(" · ");
}

const andList = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The tools this Apply writes to, for "Writes to GitHub and Jira cannot be undone from here." */
export function writesTo(items: readonly BulkItem[]): string {
  const tools = [...new Set(items.flatMap((x) => (x.task && (x.task.assign || x.task.to) ? [TOOL_NAME[x.task.kind]] : [])))];
  return andList(["GitHub", ...tools]);
}

/** The line under the reviewer before Apply: which pull requests GitHub skips, and why. Null when none. */
export function ghSkipNote(items: readonly BulkItem[], who: Who | null): string | null {
  if (!who) return null;
  const asked = items.filter((x) => x.gh.skip?.endsWith("already asked")).map((x) => `#${x.number}`);
  const author = items.filter((x) => x.gh.skip?.endsWith("opened it, so cannot review it")).map((x) => `#${x.number}`);
  const n = asked.length + author.length;
  if (!n) return null;
  const parts = [
    asked.length && `${asked.join(", ")} already ${asked.length === 1 ? "asks" : "ask"} ${who.name}.`,
    author.length && `${author.join(", ")} opened by ${who.name}, so cannot be reviewed by them.`,
  ].filter(Boolean);
  return `${parts.join(" ")} GitHub skips ${n === 1 ? "it" : "them"} there.`;
}

/** Apply is offered a reviewer is picked and at least one write would go out. */
export const canSend = (items: readonly BulkItem[], who: Who | null): boolean =>
  !!who && items.some((x) => x.gh.send || !!x.task?.assign || !!x.task?.to);

/* ---- running ---- */

/** `notSent`: the write never left this machine (the task was not read yet), so nobody "did not answer". */
export type Outcome = { state: "busy" } | { state: "ok" } | { state: "fail"; error?: string; notSent?: true };
export type Part = "gh" | "assign" | "move";
/** Per pull request number, per part. */
export type BulkOut = Record<number, Partial<Record<Part, Outcome>>>;

/** One task write, as the writer is handed it. */
export interface CardJob { number: number; kind: TrackerKind; id: string; assign: boolean; to: string | null }

export interface BulkWriters {
  /** Request the reviewer on one pull request. */
  github: (number: number) => Promise<{ ok: boolean; error?: string }>;
  /** The task's writes for one pull request: answers per part it was given. A part it does not answer did not pass. */
  card: (job: CardJob) => Promise<Partial<Record<"assign" | "move", Outcome>>>;
}

/** What to send: every planned part, or (a retry) only these. */
export type Which = Record<number, readonly Part[]>;

export function partsOf(items: readonly BulkItem[]): Which {
  const w: Which = {};
  for (const x of items) {
    const ps: Part[] = [];
    if (x.gh.send) ps.push("gh");
    if (x.task?.assign) ps.push("assign");
    if (x.task?.to) ps.push("move");
    if (ps.length) w[x.number] = ps;
  }
  return w;
}

/** The parts that failed, for "Retry failed (N)". */
export function failedParts(out: BulkOut): Which {
  const w: Which = {};
  for (const [n, o] of Object.entries(out)) {
    const ps = (Object.keys(o) as Part[]).filter((p) => o[p]?.state === "fail");
    if (ps.length) w[Number(n)] = ps;
  }
  return w;
}

export const countParts = (w: Which): number => Object.values(w).reduce((a, ps) => a + ps.length, 0);

/** Some write is still out: nothing may close the popover or clear the selection until it lands. */
export const runBusy = (out: BulkOut | null): boolean =>
  !!out && Object.values(out).some((o) => Object.values(o).some((x) => x?.state === "busy"));

/** Mark what is about to go out busy; what already passed is left as it is. */
export function startParts(out: BulkOut, w: Which): BulkOut {
  const next: BulkOut = { ...out };
  for (const [n, ps] of Object.entries(w)) {
    const o = { ...(next[Number(n)] ?? {}) };
    for (const p of ps) o[p] = { state: "busy" };
    next[Number(n)] = o;
  }
  return next;
}

/** How many go at once: enough to be quick on 30, few enough not to trip a rate limit. */
export const AT_ONCE = 4;

async function pool<T>(xs: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (at < xs.length) await fn(xs[at++]!);
  }));
}

const FAIL: Outcome = { state: "fail" };

/**
 * Send the parts in `which`: every GitHub request first, then the tasks. Each answer is handed on the moment it lands,
 * and a writer that throws is a failure, never a stuck spinner.
 */
export async function runBulk(items: readonly BulkItem[], which: Which, w: BulkWriters, on: (number: number, o: Partial<Record<Part, Outcome>>) => void): Promise<void> {
  const gh = items.filter((x) => which[x.number]?.includes("gh"));
  await pool(gh, AT_ONCE, async (x) => {
    let r: { ok: boolean; error?: string };
    try { r = await w.github(x.number); } catch { r = { ok: false }; }
    on(x.number, { gh: r.ok ? { state: "ok" } : { state: "fail", ...(r.error ? { error: r.error } : null) } });
  });
  const cards = items.filter((x) => x.task && (which[x.number]?.includes("assign") || which[x.number]?.includes("move")));
  await pool(cards, AT_ONCE, async (x) => {
    const ps = which[x.number]!;
    const t = x.task!;
    const job: CardJob = { number: x.number, kind: t.kind, id: t.id, assign: ps.includes("assign") && t.assign, to: ps.includes("move") ? t.to : null };
    let got: Partial<Record<"assign" | "move", Outcome>> = {};
    try { got = await w.card(job); } catch { got = {}; }
    const o: Partial<Record<Part, Outcome>> = {};
    if (job.assign) o.assign = got.assign ?? FAIL;
    if (job.to) o.move = got.move ?? FAIL;
    on(x.number, o);
  });
}

/* ---- reporting ---- */

export type CellState = "busy" | "done" | "failed" | "skipped";
export interface Cell { st: CellState; head: string; text: string }
export interface BulkRow { number: number; title: string; gh: Cell; task: Cell }

const saidBy = (tool: string, o: Outcome | undefined) =>
  o?.state === "fail" && o.notSent ? "Not sent: the task was not read yet." : o?.state === "fail" && o.error ? `${tool} said: ${o.error.replace(/\.$/, "")}.` : `${tool} did not answer.`;

/** One row per pull request: GitHub, then the task. The same failure sentences the one-PR picker says. */
export function bulkRows(items: readonly BulkItem[], out: BulkOut, who: Who): BulkRow[] {
  return items.map((x) => {
    const o = out[x.number] ?? {};
    let gh: Cell;
    if (!x.gh.send) gh = { st: "skipped", head: "GitHub", text: x.gh.skip ?? "" };
    else if (o.gh?.state === "ok") gh = { st: "done", head: "GitHub", text: `${who.name} asked` };
    else if (o.gh?.state === "fail") gh = { st: "failed", head: "GitHub", text: saidBy("GitHub", o.gh) };
    else gh = { st: "busy", head: "GitHub", text: "Working…" };

    const t = x.task;
    let task: Cell;
    if (!t) task = { st: "skipped", head: "Task", text: "No linked task" };
    else {
      const tool = TOOL_NAME[t.kind];
      const head = `${tool} ${t.id}`;
      const steps = [t.assign && { p: "assign" as const, text: `assigned ${who.name}`, again: `assign ${who.name}` }, t.to && { p: "move" as const, text: `moved to ${t.to}`, again: `move to ${t.to}` }]
        .filter((s): s is { p: "assign" | "move"; text: string; again: string } => !!s);
      const cantNote = t.cant ? ` · not moved: ${t.cant}` : "";
      if (t.skip) task = { st: "skipped", head, text: t.skip };
      else if (steps.some((s) => !o[s.p] || o[s.p]!.state === "busy")) task = { st: "busy", head, text: "Working…" };
      else {
        const failed = steps.filter((s) => o[s.p]?.state === "fail");
        const passed = steps.filter((s) => o[s.p]?.state === "ok");
        task = failed.length
          ? { st: "failed", head, text: `${saidBy(tool, o[failed[0]!.p])} ${passed.length ? `Already done: ${passed.map((s) => s.again).join(", ")}.` : "Nothing was changed on the card."}` }
          : { st: "done", head, text: steps.map((s) => s.text).join(" · ") + cantNote };
      }
    }
    return { number: x.number, title: x.title, gh, task };
  });
}

export function rowCounts(rows: readonly BulkRow[]): Record<"done" | "failed" | "skipped" | "busy", number> {
  const c = { done: 0, failed: 0, skipped: 0, busy: 0 };
  for (const r of rows) for (const cell of [r.gh, r.task]) c[cell.st] += 1;
  return c;
}

/** The results' foot line. Says there is no undo, and names the tools that were written to. */
export function resultLine(rows: readonly BulkRow[], items: readonly BulkItem[]): string {
  const c = rowCounts(rows);
  const head = c.busy ? "Working…" : c.failed ? `${c.failed} failed. Done steps stay done. Retry sends only the failed step.` : "Everything that could be done is done.";
  return `${head} No undo for writes to ${writesTo(items)}.`;
}
