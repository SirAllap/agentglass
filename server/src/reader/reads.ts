/*
 * READS THAT CAN RUN ON ANOTHER CONNECTION.
 *
 * Every query in the server ran on its one thread, through one connection.
 * Measured on the installed app (2026-11-11): after memory pressure the
 * database file is cold, and a read then holds that thread in the kernel
 * (state D, filemap_get_pages) for 2 to 4.5 s; nothing is answered and
 * nothing is pushed while it lasts. Typing was moved out first (relay/); this
 * is the same move for the widest history reads.
 *
 * A function here takes the connection and a `ctx`, and reads no module
 * state: what db.ts used to read on the way (project scope, provider filter,
 * the clock) arrives in `ctx`. So the same function gives the same answer on
 * the server's connection and on the reader process's (reader/readerMain.ts),
 * and there is ONE copy of each query; a second copy is the one that drifts.
 * db.ts calls these with its own connection: with the reader off nothing
 * about the server changes.
 *
 * Must not import ../db.ts: that module opens the database for writing, runs
 * the schema and starts timers at load. The reader imports this file.
 *
 * Ceiling: prices are not in `ctx`. pricing.ts builds its table at load from
 * the bundled list and AGENTGLASS_PRICING, which the reader is started with,
 * so both sides agree; a table refreshed at run time
 * (AGENTGLASS_PRICING_REFRESH) exists in the server only, and the host does
 * not send statsSummary to the reader when that is on (readerHost.ts).
 */
import type { Database } from "bun:sqlite";
import type {
  StatsSummary, CostByModel, ToolLatencyStat, TimeBucket, SkillUsage, AppUsage, TypeCount, UsageDay,
} from "../../../shared/types.ts";
import { modelLabel, hasPrice, equivalentTokens } from "../pricing.ts";

/** One SQL fragment and the values it binds, as db.ts's scope helpers build them. */
export type Clause = { clause: string; args: string[] };
/** dailyUsage's share of module state: the project scope, for each of its two tables. */
export type DailyCtx = { rollup: Clause; events: Clause };
/** statsSummary's and skillUsage's: the clock, the provider filter and the project scope. */
/** `zone` is the server's own time zone, by name: see `serverZone` and the heatmap in statsSummaryRead. */
export type StatsCtx = { now: number; provider: Clause; events: Clause; zone?: string };
/** The zone this process's clock is in, as a name another process can use. */
export const serverZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
/** Ask for one of READS somewhere else. Null means "not answered there": the caller runs it here. */
export type ReadVia = (fn: ReadName, ctx: unknown, args: unknown[]) => Promise<unknown | null>;

export const DAY_TOTALS = `SELECT day,
        SUM(events) AS events, SUM(tool_calls) AS tool_calls,
        SUM(tool_errors) AS tool_errors, SUM(errors) AS errors,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cost_usd) AS cost_usd,
        COUNT(DISTINCT session_id) AS sessions,
        CASE WHEN SUM(timed_calls) > 0
             THEN CAST(SUM(duration_ms_total) / SUM(timed_calls) AS INTEGER)
             ELSE 0 END AS avg_ms`;

export function dailyUsageRead(conn: Database, ctx: DailyCtx, fromDay?: string | null, toDay?: string | null): UsageDay[] {
  const rs = ctx.rollup;
  const es = ctx.events;
  const rWhere: string[] = [];
  const rArgs: any[] = [];
  const eWhere: string[] = [];
  const eArgs: any[] = [];
  if (fromDay) {
    rWhere.push("day >= ?"); rArgs.push(fromDay);
    // Bounded on `timestamp` rather than on date(timestamp), so the events half
    // can use the timestamp index instead of computing a date per row. With
    // retention disabled this table holds everything, and "all time" is exactly
    // when that matters.
    eWhere.push("timestamp >= CAST(strftime('%s', ?) AS INTEGER) * 1000"); eArgs.push(fromDay);
  }
  if (toDay) {
    rWhere.push("day <= ?"); rArgs.push(toDay);
    eWhere.push("timestamp < (CAST(strftime('%s', ?) AS INTEGER) + 86400) * 1000"); eArgs.push(toDay);
  }
  const rc = ` WHERE 1${rWhere.length ? ` AND ${rWhere.join(" AND ")}` : ""}${rs.clause}`;
  const ec = ` WHERE 1${eWhere.length ? ` AND ${eWhere.join(" AND ")}` : ""}${es.clause}`;
  return conn
    .query<UsageDay, any[]>(
      `WITH merged AS (
         SELECT day, session_id, events, tool_calls, tool_errors, errors,
                input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                cost_usd, duration_ms_total, timed_calls
         FROM daily_rollup${rc}
         UNION ALL
         -- Folded the same way foldExpiringEvents() folds, down to the date
         -- expression: a day that is half here and half in the rollup has to
         -- land on the same key in both halves or it splits into two days.
         SELECT date(timestamp / 1000, 'unixepoch') AS day, session_id,
                COUNT(*),
                SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END),
                SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END),
                SUM(COALESCE(is_error, 0)),
                SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
                SUM(COALESCE(cache_creation_tokens, 0)), SUM(COALESCE(cache_read_tokens, 0)),
                SUM(COALESCE(cost_usd, 0)),
                SUM(COALESCE(duration_ms, 0)),
                SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END)
         FROM events${ec}
         GROUP BY 1, 2
       )
       ${DAY_TOTALS} FROM merged GROUP BY day ORDER BY day`
    )
    .all(...rArgs, ...rs.args, ...eArgs, ...es.args);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function statsSummaryRead(conn: Database, ctx: StatsCtx, windowMs: number, tz?: string | null): StatsSummary {
  const since = ctx.now - windowMs;
  const { clause: prov, args: pa } = ctx.provider;
  const { clause: sc, args: sa } = ctx.events;
  // Every query below appends `pf` and binds `A` in this order, so folding the
  // project filter in here reaches all of them at once.
  const pf = prov + sc;
  const A = [since, ...pa, ...sa]; // bind order: timestamp, provider (if any), project (if any)

  // Every total here is from events within the window — cost and tokens
  // included — because /stats is a windowed view (last 15m / 1h / …), not a
  // lifetime one: cost_usd summed over the window's events is the spend in that
  // window, which is what the dashboard asks for. (The sessions table holds the
  // authoritative lifetime totals; those are what getSessions serves per row,
  // not what a window summary wants.) One pass, not several: counts, errors,
  // sessions, tokens and cost all cover exactly these rows, and over a wide
  // window each separate pass would be another full scan.
  const totals = conn
    .query<any, any[]>(
      `SELECT COUNT(*) AS events,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(is_error) AS errors,
              -- Errors that were actually a tool failing, which is the only
              -- numerator tool_calls can honestly serve as a denominator for.
              -- The errors column counts every errored event, and an LLM span
              -- or a notification can carry is_error too (otlp.ts sets it on
              -- "Turn complete") — dividing that by tool calls produced a
              -- health ring below zero, and insights reading "6 of 4 tool
              -- calls failed". Both ship; each answers its own question.
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END) AS tool_errors,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd
       FROM events WHERE timestamp >= ?${pf}`
    )
    .get(...A)!;
  const evtTotals = totals as { events: number; tool_calls: number; errors: number; tool_errors: number };
  const tokTotals = totals;

  // Per-model breakdown (from events so it respects the window).
  const modelRows = conn
    .query<any, any[]>(
      `SELECT model_name,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd,
              COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY model_name`
    )
    .all(...A);
  /**
   * Fold the raw ids into their labels before the panel sees them.
   *
   * The SQL groups by `model_name`, which is the raw id, and the label is
   * applied after — so two ids that share a label ("claude-opus-4-1" and
   * "claude-opus-4-5" both being Opus) arrived as two rows reading "Opus",
   * each carrying part of that model's spend, under the same name and the
   * same colour. The donut's centre was right and no legend row was.
   *
   * `sessions` is the one column that cannot be summed: it is a
   * COUNT(DISTINCT session_id) per raw id, so a session that switched model
   * version mid-run counts once in each row and twice in the fold. It is
   * counted over distinct pairs instead, below.
   */
  const sessionRows = conn
    .query<{ model_name: string | null; session_id: string }, any[]>(
      `SELECT DISTINCT model_name, session_id FROM events
       WHERE timestamp >= ? AND model_name IS NOT NULL${pf}`
    )
    .all(...A);
  const sessionsByLabel = new Map<string, Set<string>>();
  for (const r of sessionRows) {
    const label = modelLabel(r.model_name);
    const set = sessionsByLabel.get(label) ?? new Set<string>();
    set.add(r.session_id);
    sessionsByLabel.set(label, set);
  }

  const modelFold = new Map<string, CostByModel>();
  for (const r of modelRows) {
    const label = modelLabel(r.model_name);
    const e = modelFold.get(label) ?? {
      model_name: label,
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      equiv_tokens: 0, cost_usd: 0, sessions: 0, unpriced: false,
    };
    // Any contributing id without a rate makes the whole row's cost partly a
    // fallback — the honest reading, since the row is one number.
    if (!hasPrice(r.model_name)) e.unpriced = true;
    e.input_tokens += r.input_tokens ?? 0;
    e.output_tokens += r.output_tokens ?? 0;
    e.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    e.cache_read_tokens += r.cache_read_tokens ?? 0;
    /*
     * Weighted here, inside the loop, against the RAW id.
     *
     * Two ids can fold into one label and be priced differently — that is the
     * whole reason the fold exists — so weighting the folded row would apply
     * one model's ratios to another's tokens. Per raw id and then summed is
     * exact, and keeps the identity that makes this number worth leading with:
     * equivalent tokens times the base input rate is the cost.
     */
    e.equiv_tokens = (e.equiv_tokens ?? 0) + equivalentTokens(r, r.model_name);
    e.cost_usd += r.cost_usd ?? 0;
    modelFold.set(label, e);
  }
  for (const [label, e] of modelFold) e.sessions = sessionsByLabel.get(label)?.size ?? 0;
  /*
   * The window's one comparable number, summed from the same rows the
   * breakdown is built from.
   *
   * Deliberately not a separate query. The headline and the legend under it are
   * the two figures somebody checks against each other, and computing them from
   * two SQL statements is how they come to disagree — `modelRows` has no
   * `model_name IS NOT NULL` filter, so this covers events with no model too,
   * which fall to the fallback rate exactly as their cost already does.
   */
  const equivTotal = [...modelFold.values()].reduce((n, e) => n + (e.equiv_tokens ?? 0), 0);
  // Ordered on the way out: the query has no ORDER BY, and the panel renders
  // the array in the order it arrives, so without this the donut's slices
  // reshuffle between refreshes for no reason the viewer can see.
  const by_model: CostByModel[] = [...modelFold.values()].sort((a, b) => b.cost_usd - a.cost_usd);

  // Tool latency — pull durations per tool and compute percentiles in JS.
  const durRows = conn
    .query<{ tool_name: string; duration_ms: number; is_error: number }, any[]>(
      `SELECT tool_name, duration_ms, is_error FROM events
       WHERE timestamp >= ? AND hook_event_type IN ('PostToolUse','PostToolUseFailure')
         AND tool_name IS NOT NULL${pf}`
    )
    .all(...A);
  const byTool = new Map<string, { durs: number[]; errors: number; count: number }>();
  for (const r of durRows) {
    const e = byTool.get(r.tool_name) ?? { durs: [], errors: 0, count: 0 };
    e.count++; // every PostToolUse is an invocation, even without a paired duration (e.g. OTLP-logs sources)
    if (typeof r.duration_ms === "number") e.durs.push(r.duration_ms);
    if (r.is_error) e.errors++;
    byTool.set(r.tool_name, e);
  }
  const tool_latency: ToolLatencyStat[] = [...byTool.entries()]
    .map(([tool_name, { durs, errors, count }]) => {
      const sorted = [...durs].sort((a, b) => a - b);
      const total = sorted.reduce((a, b) => a + b, 0);
      return {
        tool_name,
        calls: count,
        // The percentile sample, which is not the call count: a Post with no
        // paired Pre is an invocation with no duration. Shipped so the panel
        // can say when a p95 rests on two measurements.
        timed: sorted.length,
        errors,
        p50_ms: percentile(sorted, 50),
        p95_ms: percentile(sorted, 95),
        max_ms: sorted.length ? sorted[sorted.length - 1] : 0,
        avg_ms: sorted.length ? Math.round(total / sorted.length) : 0,
        total_ms: total,
      };
    })
    .sort((a, b) => b.total_ms - a.total_ms);

  // Most-used skills with attributed cost and per-bucket activity.
  const top_skills: SkillUsage[] = skillUsageRead(conn, ctx, since, 12).slice(0, 20);

  // Per-app rollup within the window.
  /*
   * Grouped by app AND model, then folded.
   *
   * `tokens` used to be `SUM(input_tokens + output_tokens)`, which is not a
   * quantity: it adds a token that costs five to a token that costs a tenth and
   * drops the cache classes entirely. Weighting needs the model, and the model
   * is not in a group keyed on the app alone — so the group carries it and the
   * fold puts the apps back together. The extra rows are apps × models, which
   * is single digits times single digits.
   */
  const appRows = conn
    .query<any, any[]>(
      `SELECT source_app, model_name,
              COUNT(*) AS events,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(cost_usd) AS cost_usd,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY source_app, model_name`
    )
    .all(...A);
  // `sessions` is a COUNT(DISTINCT), which does not survive a fold: a session
  // that used two models would be counted once per model and twice in the sum.
  const appSessions = conn
    .query<{ source_app: string; sessions: number }, any[]>(
      `SELECT source_app, COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE timestamp >= ?${pf} GROUP BY source_app`
    )
    .all(...A);
  const appFold = new Map<string, AppUsage>();
  for (const r of appRows) {
    const e = appFold.get(r.source_app) ?? { source_app: r.source_app, events: 0, sessions: 0, tool_calls: 0, cost_usd: 0, tokens: 0 };
    e.events += r.events ?? 0;
    e.tool_calls += r.tool_calls ?? 0;
    e.cost_usd += r.cost_usd ?? 0;
    e.tokens += equivalentTokens(r, r.model_name);
    appFold.set(r.source_app, e);
  }
  for (const r of appSessions) { const e = appFold.get(r.source_app); if (e) e.sessions = r.sessions ?? 0; }
  const by_app: AppUsage[] = [...appFold.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.events - a.events);

  // Event-type mix within the window.
  const by_type: TypeCount[] = conn
    .query<TypeCount, any[]>(
      `SELECT hook_event_type, COUNT(*) AS count
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY hook_event_type ORDER BY count DESC`
    )
    .all(...A);

  // Timeline buckets.
  const bucketCount = 60;
  const bucketMs = Math.max(1000, Math.floor(windowMs / bucketCount));
  const start = Math.floor(since / bucketMs) * bucketMs;
  // The buckets are aligned DOWN from `since`, so they span [start, start +
  // 60*bucketMs), whose upper edge is <= now — the most recent up-to-one-bucket
  // of events (an event at `now` always) fell past the last bucket and vanished
  // from the chart while still counting in the totals. Fold anything at or past
  // the last bucket into it, so every event in the window lands somewhere and
  // sum(bucket events) == totals.events.
  const lastKey = start + (bucketCount - 1) * bucketMs;
  const buckets = new Map<number, TimeBucket>();
  for (let i = 0; i < bucketCount; i++) {
    const t = start + i * bucketMs;
    buckets.set(t, { t, events: 0, errors: 0, cost_usd: 0, tokens: 0 });
  }
  const tlRows = conn
    .query<any, any[]>(
      // model_name and both cache columns come along so the bucket's `tokens`
      // can be weighted per row — see the fold below and equivalentTokens().
      `SELECT timestamp, is_error, cost_usd, model_name,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
         FROM events WHERE timestamp >= ?${pf}`
    )
    .all(...A);
  /**
   * The heatmap is a weekday x hour grid, and neither exists without a clock.
   *
   * It used to bucket with getDay()/getHours(), which read the *server*
   * process's zone, while the timeline beside it buckets UTC epochs and is
   * rendered in the viewer's. So the cell labelled "Tue 14:00" and the tick
   * labelled 14:00 described different real hours whenever the two clocks
   * differed — shifted by the offset, with whole day columns moving when it
   * crossed midnight. Remote access and the phone companion exist precisely
   * so that the viewer is not on the server, so this was reachable rather
   * than theoretical.
   *
   * The formatter is built once: formatToParts per event over a wide window
   * is thousands of calls. An absent or unknown zone falls back to the old
   * behaviour rather than throwing — the server's clock is still better than
   * a 500.
   */
  const heatmap = new Array(168).fill(0);
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let fmt: Intl.DateTimeFormat | null = null;
  /* Without a viewer zone, or with one nobody knows, the grid is drawn on the SERVER's clock, and that
     clock is named in `ctx`, not read from this process: the reader process is started with a three
     variable environment, so its own local zone need not be the server's. Its first real run answered
     a different heatmap than the server for exactly this reason (the server's zone came from its
     runtime, not from a TZ variable there was to pass on). Only when neither zone can be used does
     the process's own clock decide. */
  for (const zone of [tz, ctx.zone]) {
    if (!zone || fmt) continue;
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", hour12: false });
    } catch { fmt = null; }
  }
  const cellOf = (ms: number): number => {
    if (!fmt) { const d = new Date(ms); return d.getDay() * 24 + d.getHours(); }
    const parts = fmt.formatToParts(ms);
    const wd = WEEKDAY[parts.find((x) => x.type === "weekday")?.value ?? "Sun"] ?? 0;
    // hour12:false spells midnight "24" in some locales.
    const hr = Number(parts.find((x) => x.type === "hour")?.value ?? 0) % 24;
    return wd * 24 + hr;
  };
  for (const r of tlRows) {
    const t = Math.min(lastKey, Math.floor(r.timestamp / bucketMs) * bucketMs);
    const b = buckets.get(t);
    if (b) {
      b.events++;
      b.errors += r.is_error;
      b.cost_usd += r.cost_usd ?? 0;
      b.tokens += equivalentTokens(r, r.model_name);
    }
    heatmap[cellOf(r.timestamp)]++;
  }

  return {
    totals: {
      events: evtTotals.events ?? 0,
      sessions: tokTotals.sessions ?? 0,
      tool_calls: evtTotals.tool_calls ?? 0,
      errors: evtTotals.errors ?? 0,
      tool_errors: evtTotals.tool_errors ?? 0,
      cost_usd: tokTotals.cost_usd ?? 0,
      input_tokens: tokTotals.input_tokens ?? 0,
      output_tokens: tokTotals.output_tokens ?? 0,
      cache_creation_tokens: tokTotals.cache_creation_tokens ?? 0,
      cache_read_tokens: tokTotals.cache_read_tokens ?? 0,
      equiv_tokens: equivTotal,
    },
    by_model,
    tool_latency,
    timeline: [...buckets.values()].sort((a, b) => a.t - b.t),
    top_skills,
    by_app,
    by_type,
    heatmap,
    window_ms: windowMs,
  };
}

export function skillUsageRead(conn: Database, ctx: StatsCtx, since = 0, bucketCount = 12): SkillUsage[] {
  const { clause: pf, args: pa } = ctx.provider;
  // Project scope, same as every other aggregation in computeStatsSummary. Its
  // absence here leaked top_skills — and the cost charged to them — from every
  // other project on the machine into a cockpit opened for one.
  const { clause: sc, args: sa } = ctx.events;
  const invocations = conn
    .query<{ session_id: string; timestamp: number; skill: string }, any[]>(
      `SELECT session_id, timestamp, json_extract(payload, '$.tool_input.skill') AS skill
       FROM events
       WHERE hook_event_type = 'PreToolUse' AND tool_name = 'Skill'
         AND json_extract(payload, '$.tool_input.skill') IS NOT NULL AND timestamp >= ?${pf}${sc}
       ORDER BY session_id, timestamp`
    )
    .all(since, ...pa, ...sa);
  if (!invocations.length) return [];

  const bySession = new Map<string, { timestamp: number; skill: string }[]>();
  for (const inv of invocations) {
    const arr = bySession.get(inv.session_id) ?? [];
    arr.push(inv);
    bySession.set(inv.session_id, arr);
  }

  const acc = new Map<string, { calls: number; cost_usd: number; last_used: number; buckets: number[] }>();
  const get = (skill: string) => {
    let a = acc.get(skill);
    if (!a) {
      a = { calls: 0, cost_usd: 0, last_used: 0, buckets: new Array(bucketCount).fill(0) };
      acc.set(skill, a);
    }
    return a;
  };

  const start = since || invocations.reduce((m, i) => Math.min(m, i.timestamp), ctx.now);
  const bucketMs = Math.max(1, (ctx.now - start) / bucketCount);
  for (const inv of invocations) {
    const a = get(inv.skill);
    a.calls++;
    a.last_used = Math.max(a.last_used, inv.timestamp);
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((inv.timestamp - start) / bucketMs)));
    a.buckets[idx]++;
  }

  // Charge each cost-bearing event to the running skill at that moment — scoped
  // too, or an out-of-project session's spend is attributed to an in-project
  // skill it never ran.
  const costRows = conn
    .query<{ session_id: string; timestamp: number; cost_usd: number }, any[]>(
      `SELECT session_id, timestamp, cost_usd FROM events WHERE cost_usd > 0 AND timestamp >= ?${sc}`
    )
    .all(since, ...sa);
  for (const c of costRows) {
    const invs = bySession.get(c.session_id);
    if (!invs) continue;
    let owner: string | null = null;
    for (const inv of invs) {
      if (inv.timestamp <= c.timestamp) owner = inv.skill;
      else break;
    }
    if (owner) get(owner).cost_usd += c.cost_usd;
  }

  return [...acc.entries()]
    .map(([skill, a]) => ({ skill, ...a }))
    .sort((a, b) => b.calls - a.calls || b.cost_usd - a.cost_usd);
}

/** What the reader answers, by name. Arguments arrive as JSON, so an absent one is null. */
export const READS = {
  dailyUsage: (conn: Database, ctx: unknown, a: unknown[]) =>
    dailyUsageRead(conn, ctx as DailyCtx, a[0] as string | null, a[1] as string | null),
  statsSummary: (conn: Database, ctx: unknown, a: unknown[]) =>
    statsSummaryRead(conn, ctx as StatsCtx, a[0] as number, a[1] as string | null),
} as const;
export type ReadName = keyof typeof READS;
