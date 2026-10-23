/*
 * When the orchestration policy's rules are on.
 *
 * `shared/orchestration.ts` says what a rule is and what to run when it is on;
 * this file says whether it is on, from real readings, and remembers it. It
 * acts on nothing beyond a row of state and a line in the Activity log: the
 * resolver reads `active` and slice S5 starts workers from it.
 *
 * ── events, not a clock ──────────────────────────────────────────────────
 * No interval, no request. `evaluate` runs when a usage reading changes
 * (usageevents.ts: after a statusline post, a poll, a Codex refresh), when a
 * window's `resetsAt` passes, and at the two edges of an `hours` window; each
 * of those is one `setTimeout`, armed from what is stored, so a restart arms
 * them again. Readings come from what this process already holds (`peekUsage`,
 * the Codex session file); asking Anthropic is never done from here.
 *
 * ── a switch that does not flap ──────────────────────────────────────────
 * A usage rule turns on at `remaining <= N` and off only at `remaining >=
 * N + 5` or when the window's `resetsAt` changes; between the two it keeps its
 * last answer. A reading that is missing, errored, or older than the limit
 * (30 min for the 5 h window, 6 h for the weekly one) changes NOTHING and says
 * why in `holding`: a failed poll is not a reset.
 *
 * Ceilings, stated: an `hours` window belongs to the day it starts on (Fri
 * 22:00 to 06:00 is Friday's); the gauge is per provider on this machine, not per account; a project policy
 * with a budget trigger watches that project's budgets and the machine-wide
 * ones, the global policy any budget; a Codex reading is as old as its last
 * turn and is re-read whenever any other event fires.
 */
import type { PolicyRule, Trigger, UsageProviderId } from "../../shared/orchestration.ts";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import { budgetStatus } from "./budget.ts";
import { anthropicUsage } from "./providerusage.ts";
import { codexUsage } from "./codexusage.ts";
import { policyRoots, readStoredPolicy } from "./config.ts";
import { db, recordAction } from "./db.ts";
import { onUsageReading } from "./usageevents.ts";
import { peekUsage } from "./usage.ts";

/** How far past the threshold a reading has to climb before a rule goes off. */
export const HYSTERESIS = 5;
const MIN = 60_000;
/** Older than this and a reading of that window is not evidence. */
export const STALE_MS = { "5h": 30 * MIN, weekly: 6 * 60 * MIN } as const;
const MAX_TIMEOUT = 2 ** 31 - 1;

// ── hours, in a zone ─────────────────────────────────────────────────────

const parts = (ms: number, tz?: string) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "numeric", minute: "numeric",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year!, mo: +o.month!, d: +o.day!, h: +o.hour! % 24, mi: +o.minute!,
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday!),
  };
};

const hm = (s: string): number => +s.slice(0, 2) * 60 + +s.slice(3, 5);

/** Whether an `hours` trigger holds at this instant. The window belongs to the
 *  day it STARTS on, so Fri 22:00 to 06:00 still holds at Saturday 03:00. */
export function hoursOn(t: Extract<Trigger, { kind: "hours" }>, ms: number, tz?: string): boolean {
  const p = parts(ms, tz);
  const cur = p.h * 60 + p.mi;
  const from = hm(t.from), to = hm(t.to);
  if (from < to) return t.days.includes(p.day) && cur >= from && cur < to;
  return (cur >= from && t.days.includes(p.day)) || (cur < to && t.days.includes((p.day + 6) % 7));
}

/** The instant a wall-clock time falls on in a zone. A time that does not exist
 *  (the hour a clock skips) lands an hour either side, which is where the
 *  clock itself went. */
function instantAt(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

/** The next edge of an `hours` window after `ms`: the first start or end time
 *  on the next nine days. */
export function nextHoursEdge(t: Extract<Trigger, { kind: "hours" }>, ms: number, tz?: string): number {
  const p = parts(ms, tz);
  let best = Infinity;
  for (let k = 0; k <= 9; k++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + k));
    for (const at of [t.from, t.to]) {
      const e = instantAt(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +at.slice(0, 2), +at.slice(3, 5), tz);
      if (e > ms && e < best) best = e;
    }
  }
  return best;
}

// ── readings ─────────────────────────────────────────────────────────────

/** One provider's reading, with a flag for "the last poll failed". */
export interface UsageRead { usage: ProviderUsage; error?: string }
export type UsageSource = (provider: UsageProviderId) => UsageRead | null;

/** What this process already knows, never a request. */
export async function heldUsage(): Promise<UsageSource> {
  const payload = await peekUsage();
  const anthropic: UsageRead | null = payload
    ? { usage: anthropicUsage(payload), ...(payload.error ? { error: payload.error } : {}) }
    : null;
  return (p) => (p === "anthropic" ? anthropic : p === "codex" ? { usage: codexUsage() } : null);
}

const age = (ms: number): string => (ms < 120 * MIN ? `${Math.max(1, Math.round(ms / MIN))} min` : `${Math.round(ms / (60 * MIN))} h`);

/** What one trigger needs to remember between evaluations. */
interface Mem { on: boolean; reset?: string }
interface Answer { on: boolean; mem: Mem; reading?: string; readingAt?: number; hold?: string; wake?: number }

function windowsOf(u: ProviderUsage, want: "5h" | "weekly" | "either" | "any"): QuotaWindow[] {
  const five = u.windows.find((w) => w.minutes === 300);
  // A per-model weekly bucket carries the model's name, never "weekly".
  const week = u.windows.find((w) => w.minutes === 10080 && w.label === "weekly");
  if (want === "5h") return five ? [five] : [];
  if (want === "weekly") return week ? [week] : [];
  return [five, week].filter((w): w is QuotaWindow => !!w);
}

/** A gauge-watching trigger: `usage` (turns on at N remaining) and `limit`
 *  (the same at 0). */
function gauge(
  provider: UsageProviderId, want: "5h" | "weekly" | "either" | "any", atMost: number,
  prev: Mem | undefined, now: number, read: UsageSource,
): Answer {
  const was = prev ?? { on: false };
  const keep = (hold: string): Answer => ({ on: was.on, mem: was, hold });
  const r = read(provider);
  if (!r || !r.usage.available) return keep(`no usage reading for ${provider === "anthropic" ? "Claude" : "Codex"} yet`);
  if (r.error) return keep(`the last usage poll failed (${r.error}); keeping the last state`);
  const ws = windowsOf(r.usage, want);
  if (!ws.length) return keep(`the reading has no ${want === "any" ? "" : want + " "}window`);
  const seen = r.usage.observedAt;
  if (typeof seen !== "number") return keep("the usage reading carries no time");
  const limit = want === "weekly" ? STALE_MS.weekly : STALE_MS["5h"];
  if (now - seen > limit) return keep(`the last usage reading is ${age(now - seen)} old`);

  const remaining = Math.max(0, Math.min(100, ...ws.map((w) => 100 - w.usedPercent)));
  const reset = ws.map((w) => w.resetsAt ?? "").join("|");
  // A new window starts from nothing: whatever was on belongs to the old one.
  const before = was.reset !== undefined && was.reset !== reset ? false : was.on;
  const on = remaining <= atMost ? true : remaining >= atMost + HYSTERESIS ? false : before;
  const next = ws.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((n) => Number.isFinite(n) && n > now);
  return {
    on, mem: { on, reset },
    reading: `${provider === "anthropic" ? "Claude" : "Codex"} ${remaining}% left`,
    readingAt: seen,
    wake: on && next.length ? Math.min(...next) + 1000 : undefined,
  };
}

// ── evaluating ───────────────────────────────────────────────────────────

export interface ScopeRules { scope: string; label: string; root?: string; rules: PolicyRule[] }

export interface EvalDeps {
  now?: number;
  tz?: string;
  scopes?: ScopeRules[];
  usage?: UsageSource;
  budgetOver?: (root?: string) => boolean;
  /** Where wake-ups go. The default is `setTimeout`; a test records them. */
  schedule?: (at: number, fn: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface Flip { scope: string; ruleId: string; name: string; on: boolean; reading: string }
export interface RuleState {
  scope: string; ruleId: string; name: string; active: boolean; since: number;
  reading: string; readingAt: number; holding: string;
}

interface Row { scope: string; rule_id: string; active: number; since: number; reading: string; reading_at: number; holding: string; memory: string }
const load = db.query<Row, [string, string]>(`SELECT * FROM policy_state WHERE scope = ? AND rule_id = ?`);
const loadAll = db.query<Row, []>(`SELECT * FROM policy_state`);
const save = db.query<never, [string, string, number, number, string, number, string, string]>(`
  INSERT INTO policy_state (scope, rule_id, active, since, reading, reading_at, holding, memory)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(scope, rule_id) DO UPDATE SET active = excluded.active, since = excluded.since,
    reading = excluded.reading, reading_at = excluded.reading_at, holding = excluded.holding, memory = excluded.memory`);
const drop = db.query<never, [string, string]>(`DELETE FROM policy_state WHERE scope = ? AND rule_id = ?`);

export function storedScopes(): ScopeRules[] {
  const out: ScopeRules[] = [];
  const g = readStoredPolicy();
  if (g) out.push({ scope: "global", label: "all projects", rules: g.rules });
  for (const root of policyRoots()) {
    const p = readStoredPolicy(root);
    if (p) out.push({ scope: root, label: root.split("/").filter(Boolean).pop() ?? root, root, rules: p.rules });
  }
  return out;
}

/** Whether a budget this scope watches has run out. Asked only when a rule
 *  has a budget trigger: it reads the spend. */
export function budgetOverFor(root?: string): boolean {
  return budgetStatus().some((s) => s.level === "over" && (!root || !s.budget.root || s.budget.root === root));
}

const timers = new Map<string, { at: number; handle: unknown }>();

function arm(key: string, at: number, now: number, d: Required<Pick<EvalDeps, "schedule" | "cancel">>, run: () => void): void {
  const old = timers.get(key);
  if (old?.at === at) return;
  if (old) d.cancel(old.handle);
  timers.delete(key);
  if (!Number.isFinite(at) || at <= now) return;
  // A wake-up further out than a timer can count comes back to re-arm itself.
  // The entry goes before the run, so the evaluation it starts arms afresh.
  timers.set(key, { at, handle: d.schedule(Math.min(at, now + MAX_TIMEOUT), () => { timers.delete(key); run(); }) });
}

/** The wake-ups armed right now, for the state route and the tests. */
export const armedWakeups = (): { key: string; at: number }[] => [...timers].map(([key, v]) => ({ key, at: v.at }));

const realSchedule = (at: number, fn: () => void): unknown => {
  const h = setTimeout(fn, Math.max(0, at - Date.now()));
  h.unref?.();
  return h;
};

/**
 * Decide every rule's switch from the readings in hand, write what changed,
 * log each flip once, and arm the next wake-up. Pure of requests: the readings
 * are handed in or come from what this process holds.
 */
export async function evaluate(deps: EvalDeps = {}): Promise<{ flips: Flip[] }> {
  const now = deps.now ?? Date.now();
  const scopes = deps.scopes ?? storedScopes();
  const needsGauge = scopes.some((s) => s.rules.some((r) => r.enabled && r.when.some((t) => t.kind === "usage" || t.kind === "limit")));
  const usage = deps.usage ?? (needsGauge ? await heldUsage() : () => null);
  const budgetOver = deps.budgetOver ?? budgetOverFor;
  const sched = { schedule: deps.schedule ?? realSchedule, cancel: deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)) };
  const rerun = () => { void evaluate(deps).catch((e) => console.error("[policy] evaluate failed:", e instanceof Error ? e.message : e)); };
  const flips: Flip[] = [];
  const seen = new Set<string>();

  for (const sc of scopes) {
    for (const rule of sc.rules) {
      const key = `${sc.scope}\u0000${rule.id}`;
      seen.add(key);
      const row = load.get(sc.scope, rule.id);
      const prev: Mem[] = row ? (JSON.parse(row.memory) as Mem[]) : [];
      const wasActive = !!row?.active;
      const mem: Mem[] = [];
      const readings: string[] = [];
      let readingAt = row?.reading_at ?? 0;
      const holds: string[] = [];
      let all = rule.enabled;
      const wakes: number[] = [];

      if (rule.enabled) {
        rule.when.forEach((t, i) => {
          let a: Answer;
          switch (t.kind) {
            case "always": a = { on: true, mem: { on: true } }; break;
            case "budget": { const on = budgetOver(sc.root); a = { on, mem: { on }, reading: on ? "budget used up" : "budget within limit" }; break; }
            case "hours": {
              const on = hoursOn(t, now, deps.tz);
              a = { on, mem: { on }, wake: nextHoursEdge(t, now, deps.tz) };
              break;
            }
            case "usage": a = gauge(t.provider, t.window, t.remainingAtMost, prev[i], now, usage); break;
            case "limit": a = gauge(t.provider, "any", 0, prev[i], now, usage); break;
          }
          mem[i] = a.mem;
          if (a.reading) readings.push(a.reading);
          if (a.readingAt) readingAt = Math.max(readingAt, a.readingAt);
          if (a.hold) holds.push(a.hold);
          if (a.wake) wakes.push(a.wake);
          if (!a.on) all = false;
        });
      }

      const reading = readings.length ? readings.join("; ") : (row?.reading ?? "");
      const holding = holds.length ? `holding: ${holds[0]}` : "";
      if (all !== wasActive) {
        const f: Flip = { scope: sc.scope, ruleId: rule.id, name: rule.name, on: all, reading: rule.enabled ? reading : "rule switched off" };
        flips.push(f);
        recordAction({ actor: "policy", action: all ? "policy/on" : "policy/off", target: rule.name, ok: true, detail: `${sc.label}: ${f.reading}`.slice(0, 200), at: now });
      }
      save.run(sc.scope, rule.id, all ? 1 : 0, all !== wasActive ? now : (row?.since ?? 0), reading, readingAt, holding, JSON.stringify(mem));

      const wake = wakes.length ? Math.min(...wakes) : Infinity;
      arm(key, wake, now, sched, rerun);
    }
  }

  // A rule that is gone stops applying; if it was on, that is a flip too.
  for (const row of loadAll.all()) {
    const key = `${row.scope}\u0000${row.rule_id}`;
    if (seen.has(key)) continue;
    if (row.active) {
      flips.push({ scope: row.scope, ruleId: row.rule_id, name: row.rule_id, on: false, reading: "rule removed" });
      recordAction({ actor: "policy", action: "policy/off", target: row.rule_id, ok: true, detail: "rule removed", at: now });
    }
    drop.run(row.scope, row.rule_id);
    const t = timers.get(key);
    if (t) { sched.cancel(t.handle); timers.delete(key); }
  }
  return { flips };
}

/** Every rule's switch as stored, for the state route and the resolver. */
export function ruleStates(scopes: ScopeRules[] = storedScopes()): RuleState[] {
  const out: RuleState[] = [];
  for (const sc of scopes) {
    for (const rule of sc.rules) {
      const r = load.get(sc.scope, rule.id);
      out.push({
        scope: sc.scope, ruleId: rule.id, name: rule.name,
        active: !!r?.active && rule.enabled, since: r?.since ?? 0,
        reading: r?.reading ?? "", readingAt: r?.reading_at ?? 0, holding: r?.holding ?? "",
      });
    }
  }
  return out;
}

let started = false;
/** Hook the evaluator to the events that change a reading, and settle once
 *  from what is stored (which also arms the wake-ups again after a restart). */
export function startPolicyEvaluator(): void {
  if (started) return;
  started = true;
  onUsageReading(() => { void evaluate().catch((e) => console.error("[policy] evaluate failed:", e instanceof Error ? e.message : e)); });
  void evaluate().catch((e) => console.error("[policy] evaluate failed:", e instanceof Error ? e.message : e));
}

/** Test seam: forget the armed wake-ups, as a restart does. */
export function __forgetWakeups(): void { timers.clear(); }
