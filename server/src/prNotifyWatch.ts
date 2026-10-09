/*
 * "Tell me when this pull request's CI does X."
 *
 * A person leaves a PR waiting for its checks, goes to other work, forgets, and
 * by the time he looks main has moved three hundred commits. So he can ask,
 * per PR, to be told — and the asking has to outlive the window, which is why
 * the rules live here in the database and not in the page.
 *
 * A LIST of rules per PR (`PrWatchRule`, shared/types.ts), not a handful of
 * booleans: the next kind of rule is one more member of that union and one more
 * case in `evalRule`.
 *
 * Requests. Nothing here polls on its own account except the CI tick, and the
 * CI tick reads through `prRollup` — one GraphQL call, forced past the 30 s TTL
 * it shares with the board's card, because a cached answer would add its age to
 * the wait — every 30 s per PR whose CI is RUNNING and every three minutes per
 * PR with nothing running (a push or a re-run shows up as running on the next
 * of those), and NOT AT ALL when nothing is waiting. The cadence follows the
 * suite, not the age of the rule: measured, a rule armed for over half an hour
 * was read every three minutes and a suite that went green was announced four
 * to five minutes later, with the board's counts just as stale. Comments
 * cost nothing: they ride the talk note the list poll already derives
 * (`subscribeTalk` in prs.ts), so a `comment` rule only hears about a PR the
 * list poll reads (yours, or one you were asked to review).
 *
 * Firing. A one-shot rule is CLAIMED with an UPDATE ... WHERE active = 1 before
 * anything is delivered, exactly as reminders.ts does: a crash between claim
 * and delivery costs one missed ping, the other order costs a duplicate. A
 * fired rule is kept, inactive, with what it said, so the button can show the
 * last result. A `comment` rule is the exception and stays on.
 *
 * Ceilings, chosen and not missed:
 *  - "all CI passed" is every check the rollup lists, not only the required
 *    ones; GitHub's required-ness is not read here.
 *  - a rule added on a PR whose checks are ALREADY green fires on the next
 *    tick: it cannot tell "green since this morning" from "just went green".
 *  - `check.match` is a substring, not a regex.
 *  - no "also behind main" alert.
 *  - a CI rule that has not fired within a week is dropped, so a merged PR is
 *    not read for ever.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { raiseAsked } from "./askedAlerts.ts";
import { askedAlertKey, watchPayload } from "../../shared/notifyPayload.ts";
import { entered } from "./loopwatch.ts";
import type { PrCheck, PrCheckRollup, PrChecksRead, PrTalk, PrWatch, PrWatchFire, PrWatchPreset, PrWatchRule } from "../../shared/types.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS pr_watch (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  root TEXT NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  last_at INTEGER,
  last_text TEXT,
  -- comment rules: the newest remark already accounted for, persisted so a comment made while
  -- the server was down is still reported at the next sight of the PR
  seen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pr_watch_pr ON pr_watch(repo, number);
CREATE TABLE IF NOT EXISTS pr_watch_preset (
  repo TEXT PRIMARY KEY,
  rules TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0
);
-- Which of your PRs a repo has already shown us; number 0 marks "first read
-- done", so the PRs that were already open when auto-apply was switched on are
-- not treated as new.
-- A fire that has been decided and not yet acknowledged by a client. The row is the
-- delivery guarantee: the window may be closed when the rule fires.
CREATE TABLE IF NOT EXISTS pr_watch_fire (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_watch_seen (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
`);

/** How often the timer looks at what is due; the reads themselves are spread by `readEveryMs`. */
export const WATCH_POLL_MS = 10_000;
/** A PR whose CI is running is re-read this often, however long the rule has waited. */
export const RUNNING_READ_MS = 30_000;
const IDLE_READ_MS = 3 * 60_000;
export const CI_RULE_TTL_MS = 7 * 24 * 60 * 60_000;
const KEEP_FIRED_MS = 14 * 24 * 60 * 60_000;

export const FIRE_TTL_MS = 24 * 60 * 60_000;
const MAX_RULES_PER_PR = 20;
/** Reads per tick, so a preset applied to a busy repo cannot turn one tick into a burst. */
const MAX_READS_PER_TICK = 20;

/** `state` is the PR's own state, when the read had it: a merged or closed PR ends every watch on it. */
export interface Snapshot { checks?: PrCheckRollup; allDone: boolean; verdict: "green" | "red" | null; all: PrCheck[]; state?: string; /** The head commit these checks were read at. */ sha?: string }
export type ReadChecks = (root: string, number: number) => Promise<Snapshot | null>;
export interface Outcome { summary: string; detail: string; ok: boolean }

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/** From the wire: anything that is not a rule this file knows is dropped. */
export function coerceRule(raw: unknown): PrWatchRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "ci-pass" || r.type === "ci-fail" || r.type === "comment") return { type: r.type };
  if (r.type === "check") {
    const match = typeof r.match === "string" ? r.match.trim().slice(0, 120) : "";
    const on = r.on === "fail" || r.on === "pass" || r.on === "either" ? r.on : null;
    if (!match || !on) return null;
    return { type: "check", match, on };
  }
  return null;
}

const ruleKey = (r: PrWatchRule): string => JSON.stringify(r.type === "check" ? { ...r, match: r.match.toLowerCase() } : r);

const names = (cs: PrCheck[]): string =>
  cs.slice(0, 3).map((c) => c.name).join(", ") + (cs.length > 3 ? ` +${cs.length - 3} more` : "");

/** Does this check answer to the pattern. The workflow counts too, so "evals"
 *  finds a job called "run" inside a workflow called "Evals". */
export function checkMatches(c: PrCheck, match: string): boolean {
  return `${c.workflow} ${c.name}`.toLowerCase().includes(match.toLowerCase());
}

/**
 * Has this rule's moment come. Pure: the whole decision, with no clock and no
 * network, so every rule type can be tested by handing it a snapshot.
 * `comment` is not decided here — it is event-driven, see `onTalk`.
 */
/** A cancelled run is neither a failure nor finished: a new push or a sync with main cancels the previous runs all
 *  the time, and the rerun's result is the one that counts. */
const failed = (c: PrCheck): boolean => c.state === "failure" && !c.cancelled;
const settled = (c: PrCheck): boolean => c.done && !c.cancelled;

export function evalRule(rule: PrWatchRule, s: Snapshot): Outcome | null {
  switch (rule.type) {
    case "ci-pass":
      return s.allDone && s.verdict === "green" && s.all.every(settled) ? { summary: "CI passed", detail: "", ok: true } : null;
    case "ci-fail": {
      const bad = s.all.filter(failed);
      return bad.length ? { summary: "CI failed", detail: names(bad), ok: false } : null;
    }
    case "check": {
      const hit = s.all.filter((c) => checkMatches(c, rule.match));
      if (!hit.length) return null; // not started yet, or not in this PR: keep waiting
      const bad = hit.filter(failed);
      if (bad.length && rule.on !== "pass") return { summary: `${rule.match} failed`, detail: names(bad), ok: false };
      if (bad.length) return null;
      // skipped and neutral count as passed: they are finished and not failed
      if (rule.on !== "fail" && hit.every(settled)) {
        return { summary: `${rule.match} passed`, detail: names(hit), ok: true };
      }
      return null;
    }
    case "comment":
      return null;
  }
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

interface Row {
  id: string; repo: string; number: number; root: string; title: string; rule: string;
  active: number; created: number; last_at: number | null; last_text: string | null; seen?: number | null;
}

/* The comment rule is matched by its serialised form, not json_extract: SQLite throws on malformed JSON, and one
   bad row must not take the whole query down. coerceRule writes `{"type":...` first, and a `match` string cannot contain the
   raw sequence (its quotes are escaped). */
/** A corrupted rule column is skipped, not thrown: one bad row must not stop every list and every tick. */
const ruleOf = (r: Row): PrWatchRule | null => { try { return coerceRule(JSON.parse(r.rule)); } catch { return null; } };
const withRule = (rows: Row[]): { r: Row; rule: PrWatchRule }[] =>
  rows.flatMap((r) => { const rule = ruleOf(r); return rule ? [{ r, rule }] : []; });

const toWatch = ({ r, rule }: { r: Row; rule: PrWatchRule }): PrWatch => ({
  id: r.id, repo: r.repo, number: r.number, rule,
  active: r.active === 1,
  ...(r.last_at ? { lastAt: r.last_at } : null),
  ...(r.last_text ? { lastText: r.last_text } : null),
});

function presetRules(json: string): PrWatchRule[] {
  try { return (JSON.parse(json) as unknown[]).map(coerceRule).filter((r): r is PrWatchRule => !!r); } catch { return []; }
}

export function listWatches(): { watches: PrWatch[]; presets: PrWatchPreset[] } {
  const watches0 = db.query<Row, []>(`SELECT * FROM pr_watch ORDER BY created DESC LIMIT 500`).all();
  const watches = withRule(watches0).map(toWatch);
  const presets = db.query<{ repo: string; rules: string; auto: number }, []>(`SELECT * FROM pr_watch_preset`).all()
    .map((p) => ({ repo: p.repo, rules: presetRules(p.rules), auto: p.auto === 1 }));
  return { watches, presets };
}

const changeListeners = new Set<() => void>();
const fireListeners = new Set<(f: PrWatchFire) => void>();
export function subscribeWatchChange(fn: () => void): () => void { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; }
const checksListeners = new Set<(c: PrChecksRead) => void>();
export function subscribeWatchChecks(fn: (c: PrChecksRead) => void): () => void { checksListeners.add(fn); return () => { checksListeners.delete(fn); }; }
const sentChecks = new Map<string, string>();
/** What the watch just read, said once per change: the same read that decides a fire is the freshest one anyone has of these checks. */
export function shareChecks(repo: string, number: number, s: Snapshot): void {
  if (!s.checks) return;
  const k = `${repo}#${number}`;
  const sig = JSON.stringify(s.checks);
  if (sentChecks.get(k) === sig) return;
  sentChecks.set(k, sig);
  if (sentChecks.size > 500) sentChecks.delete(sentChecks.keys().next().value!);
  for (const fn of checksListeners) { try { fn({ repo, number, checks: s.checks, all: s.all }); } catch { /* a listener must not break the tick */ } }
}
export function subscribeWatchFire(fn: (f: PrWatchFire) => void): () => void { fireListeners.add(fn); return () => { fireListeners.delete(fn); }; }
const changed = () => { for (const fn of changeListeners) { try { fn(); } catch { /* a listener must not break a write */ } } };

export interface AddInput { repo: string; number: number; root: string; title: string; rule: unknown }

/** Adding the same rule twice is one rule; adding one that already fired turns
 *  it back on (that is what pressing the bell again means). */
export function addWatch(i: AddInput, notify = true): { ok: boolean; watch?: PrWatch; error?: string } {
  const rule = coerceRule(i.rule);
  if (!rule) return { ok: false, error: "that is not a rule I know" };
  if (!i.repo || !Number.isInteger(i.number) || i.number <= 0) return { ok: false, error: "which pull request?" };
  const key = ruleKey(rule);
  const had = db.query<Row, [string, number]>(`SELECT * FROM pr_watch WHERE repo = ? AND number = ?`).all(i.repo, i.number)
    .find((r) => { const x = ruleOf(r); return x && ruleKey(x) === key; });
  const title = (i.title || "").slice(0, 300);
  if (!had && db.query<{ n: number }, [string, number]>(`SELECT COUNT(*) AS n FROM pr_watch WHERE repo = ? AND number = ?`).get(i.repo, i.number)!.n >= MAX_RULES_PER_PR) {
    return { ok: false, error: `at most ${MAX_RULES_PER_PR} rules on one pull request` };
  }
  if (had) {
    db.run(`UPDATE pr_watch SET active = 1, created = ?, seen = ?, title = ?, root = ? WHERE id = ?`, [Date.now(), Date.now(), title, i.root, had.id]);
    if (notify) changed();
    return { ok: true, watch: toWatch({ r: { ...had, active: 1 }, rule }) };
  }
  const row: Row = {
    id: randomUUID(), repo: i.repo, number: i.number, root: i.root, title, rule: JSON.stringify(rule),
    active: 1, created: Date.now(), last_at: null, last_text: null, seen: Date.now(),
  };
  db.run(`INSERT INTO pr_watch (id, repo, number, root, title, rule, active, created, seen) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [row.id, row.repo, row.number, row.root, row.title, row.rule, row.created, row.seen ?? null]);
  if (notify) changed();
  return { ok: true, watch: toWatch({ r: row, rule }) };
}

export function removeWatch(id: string): { ok: boolean } {
  db.run(`DELETE FROM pr_watch WHERE id = ?`, [id]);
  changed();
  return { ok: true };
}

export function setPreset(repo: string, rulesIn: unknown, auto: boolean): { ok: boolean; error?: string } {
  if (!repo) return { ok: false, error: "which repository?" };
  const rules = (Array.isArray(rulesIn) ? rulesIn : []).map(coerceRule).filter((r): r is PrWatchRule => !!r)
    .filter((r, i, all) => all.findIndex((x) => ruleKey(x) === ruleKey(r)) === i).slice(0, MAX_RULES_PER_PR);
  if (!rules.length) {
    db.run(`DELETE FROM pr_watch_preset WHERE repo = ?`, [repo]);
  } else {
    db.run(`INSERT INTO pr_watch_preset (repo, rules, auto) VALUES (?, ?, ?)
            ON CONFLICT(repo) DO UPDATE SET rules = excluded.rules, auto = excluded.auto`,
      [repo, JSON.stringify(rules), auto ? 1 : 0]);
  }
  changed();
  return { ok: true };
}

/** The repo's saved rules, put on one PR. One click from the bell. */
export function applyPreset(i: Omit<AddInput, "rule">): { ok: boolean; applied: number; error?: string } {
  const p = db.query<{ rules: string }, [string]>(`SELECT rules FROM pr_watch_preset WHERE repo = ?`).get(i.repo);
  if (!p) return { ok: false, applied: 0, error: "no default saved for this repository" };
  let n = 0;
  for (const rule of presetRules(p.rules)) if (addWatch({ ...i, rule }, false).ok) n++;
  if (n) changed(); // one broadcast for the whole preset, not one per rule
  return { ok: true, applied: n };
}

/**
 * The open PRs of yours a read just returned. The ones this repo had never
 * shown us before get the repo's default rules, if `auto` is on for it. The
 * first read of a repo only seeds the set, so switching auto on does not
 * retro-fit every PR that was already open.
 */
export function sawMine(repo: string, root: string, prs: { number: number; title: string }[]): number {
  if (!repo || !prs.length) return 0;
  const seeded = db.query(`SELECT 1 FROM pr_watch_seen WHERE repo = ? AND number = 0`).get(repo) !== null;
  if (!seeded) db.run(`INSERT OR IGNORE INTO pr_watch_seen (repo, number) VALUES (?, 0)`, [repo]);
  const auto = db.query<{ auto: number }, [string]>(`SELECT auto FROM pr_watch_preset WHERE repo = ?`).get(repo)?.auto === 1;
  let applied = 0;
  for (const pr of prs) {
    const isNew = db.run(`INSERT OR IGNORE INTO pr_watch_seen (repo, number) VALUES (?, ?)`, [repo, pr.number]).changes > 0;
    if (isNew && seeded && auto && applyPreset({ repo, number: pr.number, root, title: pr.title }).applied) applied++;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// firing
// ---------------------------------------------------------------------------

/** Decided, so kept: a fire is written down BEFORE anyone is told, and stays until a client acknowledges
 *  it. The window may be closed, the laptop asleep, the socket mid-reconnect: the next client to connect
 *  is handed everything unacknowledged, oldest first, for up to FIRE_TTL_MS (`pendingFires`, `ackFire`). */
function deliver(r: Row, rule: PrWatchRule, o: Outcome, now = Date.now(), snap?: Snapshot, eventId = snap?.sha ?? String(now)): void {
  /* One alert per event: the PR, the commit the checks were read at, and the verdict. The alert is what a window
     draws and keeps until the person acts on it (askedAlerts.ts); the fire below is the bell row and the OS popup.
     A fire for an event already raised says nothing more. */
  const f: Omit<PrWatchFire, "seq"> = { ruleId: r.id, rule: rule.type, repo: r.repo, number: r.number, title: r.title, summary: o.summary, detail: o.detail, ok: o.ok };
  const alert = raiseAsked({ key: askedAlertKey({ repo: r.repo, number: r.number, sha: eventId, verdict: o.summary }), ok: o.ok,
    payload: watchPayload(f, { root: r.root, checks: snap?.checks, all: snap?.all }), armedAt: r.created }, now);
  if (!alert) return;
  f.alertId = alert.id;
  f.payload = alert.payload;
  const seq = Number(db.run(`INSERT INTO pr_watch_fire (payload, created) VALUES (?, ?)`, [JSON.stringify(f), now]).lastInsertRowid);
  for (const fn of fireListeners) { try { fn({ ...f, seq }); } catch { /* the row is kept: it is delivered at the next connect */ } }
}

export function pendingFires(now = Date.now()): PrWatchFire[] {
  db.run(`DELETE FROM pr_watch_fire WHERE created < ?`, [now - FIRE_TTL_MS]);
  return db.query<{ seq: number; payload: string }, []>(`SELECT seq, payload FROM pr_watch_fire ORDER BY seq`).all()
    .map((r) => ({ ...(JSON.parse(r.payload) as Omit<PrWatchFire, "seq">), seq: r.seq }));
}

export function ackFire(seq: number): { ok: boolean } {
  db.run(`DELETE FROM pr_watch_fire WHERE seq = ?`, [seq]);
  return { ok: true };
}

/** Claim first, deliver second. Returns whether THIS call won the claim. */
function fireOnce(r: Row, rule: PrWatchRule, o: Outcome, now: number, snap?: Snapshot): boolean {
  const text = o.detail ? `${o.summary}: ${o.detail}` : o.summary;
  const won = db.run(`UPDATE pr_watch SET active = 0, last_at = ?, last_text = ? WHERE id = ? AND active = 1`, [now, text, r.id]).changes > 0;
  if (won) { deliver(r, rule, o, now, snap); changed(); }
  return won;
}

/** A merged or closed PR ends every watch on it, the comment rule included, and a reopen does not revive them:
 *  pressing the bell again is what turns one back on. */
function endPr(repo: string, number: number, why: string, now: number): void {
  const n = db.run(`UPDATE pr_watch SET active = 0, last_at = ?, last_text = ? WHERE repo = ? AND number = ? AND active = 1`, [now, why, repo, number]).changes;
  if (n) changed();
}

const remarkText = (t: PrTalk, more: number): string => {
  const what = t.kind === "review" ? (t.state === "APPROVED" ? "approved" : t.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed") : "commented";
  return `${t.who} ${what}${more ? ` (+${more} more)` : ""}`;
};

/**
 * The people's remarks on a PR, as the list poll just read them (`subscribeTalkSeen` in prs.ts). Sticky: the
 * rule stays on and remembers the newest remark it has accounted for IN THE DATABASE, so a comment made while
 * the server was down is reported at the first sight after boot rather than swallowed as "already there".
 */
export function onTalkSeen(repo: string, number: number, title: string, talk: PrTalk[], now = Date.now()): number {
  const rows = withRule(db.query<Row, [string, number]>(
    `SELECT * FROM pr_watch WHERE repo = ? AND number = ? AND active = 1 AND rule LIKE '%"type":"comment"%'`,
  ).all(repo, number));
  const theirs = talk.filter((t) => !t.mine).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = theirs.length ? Date.parse(theirs[0]!.at) || 0 : 0;
  let fired = 0;
  for (const { r, rule } of rows) {
    const base = r.seen ?? r.created; // `seen` is set when the rule is added
    if (!(newest > base)) continue;
    const fresh = theirs.filter((t) => (Date.parse(t.at) || 0) > base);
    const text = remarkText(fresh[0]!, fresh.length - 1);
    db.run(`UPDATE pr_watch SET last_at = ?, last_text = ?, seen = ? WHERE id = ?`, [now, text, newest, r.id]);
    deliver({ ...r, title: title || r.title }, rule, { summary: "New comment", detail: text, ok: true }, now, undefined, String(newest)); // a remark is its own event: told apart by when it was said
    fired++;
  }
  if (fired) changed();
  return fired;
}

/** When a PR is next worth reading. CI rules: every 30 s while its suite is running (`running`, from the last
 *  read; unknown counts as running), every three minutes once nothing is; comment-only PRs are read only to
 *  learn whether the PR is still open, every ten minutes. Ceiling: a suite that sits pending for hours
 *  (a job waiting on an approval) is read every 30 s for as long as it does. */
export function readEveryMs(rows: Row[], running = true): number {
  const ci = rows.some((r) => ruleOf(r)?.type !== "comment");
  if (!ci) return 10 * 60_000;
  return running ? RUNNING_READ_MS : IDLE_READ_MS;
}
const schedule = new Map<string, { next: number; wait: number; running: boolean }>();
export function __resetSchedule(): void { schedule.clear(); }

/**
 * One pass: read each watched PR once (however many rules it has) and fire what has come due.
 *
 * `gate` (the timer sets it) spreads the reads per `readEveryMs`, caps them at MAX_READS_PER_TICK and, when
 * a read fails, doubles that PR's wait up to ten minutes — a rate-limited account is not helped by asking
 * again a minute later. Without it (a rule was just added, or a test) every watched PR is read now.
 */
export async function checkWatches(read: ReadChecks, now = Date.now(), gate = false): Promise<number> {
  db.run(`UPDATE pr_watch SET active = 0, last_at = ?, last_text = 'expired' WHERE active = 1 AND created < ? AND rule NOT LIKE '%"type":"comment"%'`, [now, now - CI_RULE_TTL_MS]);
  db.run(`DELETE FROM pr_watch WHERE active = 0 AND last_at < ?`, [now - KEEP_FIRED_MS]);
  const byPr = new Map<string, Row[]>();
  for (const r of db.query<Row, []>(`SELECT * FROM pr_watch WHERE active = 1`).all()) {
    const k = `${r.repo}#${r.number}`;
    (byPr.get(k) ?? byPr.set(k, []).get(k)!).push(r);
  }
  for (const k of schedule.keys()) if (!byPr.has(k)) schedule.delete(k);
  let due = [...byPr.entries()];
  if (gate) {
    due = due.filter(([k]) => (schedule.get(k)?.next ?? 0) <= now)
      .sort((a, b) => (schedule.get(a[0])?.next ?? 0) - (schedule.get(b[0])?.next ?? 0)).slice(0, MAX_READS_PER_TICK);
  }
  let fired = 0;
  for (const [k, rows] of due) {
    let snap: Snapshot | null = null;
    try { snap = await read(rows[0]!.root, rows[0]!.number); } catch { /* the next tick asks again */ }
    const running = snap ? !snap.allDone || snap.all.some((c) => !c.done) : schedule.get(k)?.running ?? true;
    const base = readEveryMs(rows, running);
    const wait = schedule.get(k)?.wait ?? base;
    schedule.set(k, snap ? { next: now + base, wait: base, running } : { next: now + Math.min(wait * 2, 10 * 60_000), wait: Math.min(wait * 2, 10 * 60_000), running });
    if (!snap) continue;
    shareChecks(rows[0]!.repo, rows[0]!.number, snap);
    if (snap.state && snap.state !== "OPEN") { endPr(rows[0]!.repo, rows[0]!.number, snap.state === "MERGED" ? "merged" : "closed", now); continue; }
    for (const { r, rule } of withRule(rows)) {
      if (rule.type === "comment") continue;
      const o = evalRule(rule, snap);
      if (o && fireOnce(r, rule, o, now, snap)) fired++;
    }
  }
  return fired;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
export function startPrNotifyWatch(read: ReadChecks): { kick: () => void } {
  const run = (gate = false) => {
    if (running) return;
    running = true;
    entered("pr notify watch");
    void checkWatches(read, Date.now(), gate).catch(() => {}).finally(() => { running = false; });
  };
  if (!timer) {
    timer = setInterval(() => run(true), WATCH_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    setTimeout(() => run(true), 5_000); // rules waiting when the server went down are read shortly after boot, off the startup path
  }
  return { kick: () => run(false) };
}
export function stopPrNotifyWatch(): void { if (timer) clearInterval(timer); timer = null; running = false; }
