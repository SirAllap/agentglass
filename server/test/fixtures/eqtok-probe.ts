/**
 * Insert a few turns and print what every stats fold made of them.
 *
 * A child process, because `db.ts` is a singleton and `bun test` shares one
 * process: which database it talks to, and which workspace scope it filters by,
 * are decided by whichever suite imported it first. The first version of the
 * test that uses this ran in-process and found zero of its own rows in a full
 * run — an earlier suite had left a workspace scope set, and events with no
 * project path are outside every scoped query.
 *
 * The three rows are each chosen to make one specific mistake visible:
 *
 *  - two models under ONE session and ONE app, so a per-app session count that
 *    got summed across the model fold reads 2 where the truth is 1;
 *  - `gpt-5.6`, whose display label is "GPT-5" and whose rates are NOT the
 *    GPT-5 row's, so weighting a folded row by its label rather than by the raw
 *    ids that fed it produces a different number;
 *  - a large cache read in every turn, which is the class the old figure
 *    dropped and the one that dominates a real session.
 *
 * Argv: a directory to keep the scratch database in.
 */
export {};

const dir = process.argv[2]!;
process.env.AGENTGLASS_DB = `${dir}/eq.db`;
process.env.XDG_CONFIG_HOME = dir;
// Deliberately no AGENTGLASS_ROOT: it sets a workspace scope, and a scoped
// query drops every event with no project path — which is all of these. That
// is the same filter that made the in-process version of this test find
// nothing at all, so leaving it out here is the point rather than an oversight.

const db = await import("../../src/db.ts");
const pricing = await import("../../src/pricing.ts");

const TURN = { input_tokens: 1_000, output_tokens: 500, cache_creation_tokens: 2_000, cache_read_tokens: 200_000 };

/** [app, session, raw model id] */
const ROWS: [string, string, string][] = [
  ["eqtok-app-alpha", "eqtok-session-multi", "claude-opus-4.5"],
  ["eqtok-app-alpha", "eqtok-session-multi", "claude-haiku-4.5"],
  ["eqtok-app-beta", "eqtok-session-gpt", "gpt-5.6"],
];

const now = Date.now();
ROWS.forEach(([app, session, model], i) =>
  db.insertEvent({
    source_app: app, session_id: session, event_id: null, hook_event_type: "Stop",
    tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
    model_name: model, is_error: 0, error_text: null,
    usage: { ...TURN }, usage_is_cumulative: false,
    timestamp: now - (i + 1) * 1000, payload: {},
  } as any));

/**
 * What each folded row SHOULD hold: every contributing raw id weighted by its
 * own rates, summed. Computed here from the ids actually inserted, so the test
 * asserts an exact number rather than a range — a range is what let "weighted
 * by the label" survive the first time.
 */
const expectBy = (pick: (r: [string, string, string]) => string): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const r of ROWS) m[pick(r)] = (m[pick(r)] ?? 0) + pricing.equivalentTokens(TURN, r[2]);
  return m;
};

const s = db.statsSummary(24 * 60 * 60_000);
console.log(JSON.stringify({
  turn: TURN,
  totals: s.totals,
  expected_total: ROWS.reduce((n, r) => n + pricing.equivalentTokens(TURN, r[2]), 0),
  expected_by_label: expectBy((r) => pricing.modelLabel(r[2])),
  expected_by_app: expectBy((r) => r[0]),
  by_model: s.by_model.map((m) => ({
    model_name: m.model_name, equiv_tokens: m.equiv_tokens, cost_usd: m.cost_usd,
  })),
  by_app: s.by_app,
  timeline_tokens: s.timeline.reduce((n, b) => n + b.tokens, 0),
  sessions: db.getSessions(50).map((r) => ({
    session_id: r.session_id, model_name: r.model_name, equiv_tokens: r.equiv_tokens,
    input_tokens: r.input_tokens, output_tokens: r.output_tokens,
    expected: pricing.equivalentTokens(r, r.model_name),
  })),
  events: db.getRecent(50).map((e) => ({
    id: e.id, model_name: e.model_name, equiv_tokens: e.equiv_tokens,
    expected: pricing.equivalentTokens(e, e.model_name),
  })),
  detail: (() => {
    // The GPT session, whose single turn has a real cache write — so a detail
    // query that stopped selecting the cache columns is a different number
    // rather than merely a smaller one.
    const d = db.getSession("eqtok-session-gpt");
    return d && {
      equiv_tokens: d.equiv_tokens, input_tokens: d.input_tokens, output_tokens: d.output_tokens,
      expected: pricing.equivalentTokens(TURN, "gpt-5.6"),
    };
  })(),
}));
