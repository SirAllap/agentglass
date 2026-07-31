// Model pricing, USD per 1,000,000 tokens.
//
// These are user-editable defaults. Whatever source feeds agentglass (Claude
// Code, an OpenTelemetry GenAI exporter, a custom adapter) reports a
// `model_name` string; we match it case-insensitively against the `match`
// patterns below (first hit wins), falling back to DEFAULT_PRICE if nothing
// matches. Override at runtime with AGENTGLASS_PRICING=/path/to/pricing.json
// (same shape as PRICE_TABLE).
//
// Cache pricing: `cache_write` = 5m cache creation, `cache_read` = cache hits.
// These drift — verify current numbers with each provider before trusting cost
// (Anthropic, OpenAI, Google …), or point AGENTGLASS_PRICING at your own table.
//
// The OpenAI rows were last checked on 2026-07-28 against two independent
// sources that agreed on every value: OpenAI's own per-model pages under
// developers.openai.com/api/docs/models/, and BerriAI/litellm's
// model_prices_and_context_window.json, which is the table a large number of
// deployments already bill against. Where a value could not be corroborated it
// was left alone — a guess that looks authoritative is worse than the honest
// `unpriced` mark the UI already carries for a model with no row at all.

export interface ModelPrice {
  match: string[]; // substrings matched against lowercased model_name
  // Whole model names, for ids too short to be safe as substrings ("k3" would
  // otherwise price "task3-custom-model"). A context suffix still counts as the
  // same model: "k3" matches `k3[1m]` too, the way providerOf and modelLabelOf
  // already treat it, so a new window never has to be added in three places.
  exact?: string[];
  label: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export const DEFAULT_PRICE: Omit<ModelPrice, "match" | "label"> = {
  input: 3,
  output: 15,
  cache_write: 3.75,
  cache_read: 0.3,
};

export const PRICE_TABLE: ModelPrice[] = [
  // Order matters: more specific patterns first.
  // --- Anthropic (Claude) ---
  // Rates are per-MTok. Opus 4.x is $5/$25 — the old $15/$75 was Opus 3 / 4.0,
  // and since Opus is the default model here it inflated every cost figure ~3x.
  // Cache: write = 1.25x input (5-min), read = 0.1x input.
  { match: ["opus"], label: "Opus", input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  { match: ["sonnet"], label: "Sonnet", input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  { match: ["haiku"], label: "Haiku", input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  { match: ["fable"], label: "Fable", input: 10, output: 50, cache_write: 12.5, cache_read: 1.0 },
  { match: ["mythos"], label: "Mythos", input: 10, output: 50, cache_write: 12.5, cache_read: 1.0 },

  // --- OpenAI ---
  //
  // GPT-5 used to sit in the GPT-4.1 row, which meant every GPT-5 session was
  // billed at 2/8 instead of 1.25/10 — input 60% too high, output 20% too low,
  // cache reads 4x too high — and no 5.x variant existed at all, so a 5.6 or a
  // 5-pro run fell into DEFAULT_PRICE, which is Sonnet's rate.
  //
  // ORDER IS LOAD-BEARING here, more than anywhere else in this table: `match`
  // is a substring test and "gpt-5" is a substring of every one of these. The
  // specific rows have to come first or they are unreachable.
  //
  // CACHE WRITES. OpenAI did not charge for them at all until the 5.6 family,
  // which bills cache creation at 1.25x the uncached input rate. So a zero here
  // is a fact about the model, not a gap in the table — see the test.
  { match: ["gpt-5.6-luna"], label: "GPT-5.6 Luna", input: 1, output: 6, cache_write: 1.25, cache_read: 0.1 },
  { match: ["gpt-5.6-terra"], label: "GPT-5.6 Terra", input: 2.5, output: 15, cache_write: 3.125, cache_read: 0.25 },
  { match: ["gpt-5.6"], label: "GPT-5.6", input: 5, output: 30, cache_write: 6.25, cache_read: 0.5 },
  { match: ["gpt-5.5-pro", "gpt-5.4-pro"], label: "GPT-5.5 Pro", input: 30, output: 180, cache_write: 0, cache_read: 3 },
  { match: ["gpt-5.5"], label: "GPT-5.5", input: 5, output: 30, cache_write: 0, cache_read: 0.5 },
  { match: ["gpt-5.4-nano"], label: "GPT-5.4 nano", input: 0.2, output: 1.25, cache_write: 0, cache_read: 0.02 },
  { match: ["gpt-5.4-mini"], label: "GPT-5.4 mini", input: 0.75, output: 4.5, cache_write: 0, cache_read: 0.075 },
  { match: ["gpt-5.4"], label: "GPT-5.4", input: 2.5, output: 15, cache_write: 0, cache_read: 0.25 },
  { match: ["gpt-5.2-pro"], label: "GPT-5.2 Pro", input: 21, output: 168, cache_write: 0, cache_read: 0 },
  { match: ["gpt-5.3", "gpt-5.2"], label: "GPT-5.2", input: 1.75, output: 14, cache_write: 0, cache_read: 0.175 },
  { match: ["gpt-5.1-codex-mini"], label: "GPT-5.1 Codex mini", input: 0.25, output: 2, cache_write: 0, cache_read: 0.025 },
  { match: ["gpt-5.1"], label: "GPT-5.1", input: 1.25, output: 10, cache_write: 0, cache_read: 0.125 },
  { match: ["gpt-5-pro"], label: "GPT-5 Pro", input: 15, output: 120, cache_write: 0, cache_read: 0 },
  { match: ["gpt-5-nano"], label: "GPT-5 nano", input: 0.05, output: 0.4, cache_write: 0, cache_read: 0.005 },
  { match: ["gpt-5-mini"], label: "GPT-5 mini", input: 0.25, output: 2, cache_write: 0, cache_read: 0.025 },
  // Catches gpt-5, gpt-5-codex, gpt-5-chat-latest — all one rate.
  { match: ["gpt-5"], label: "GPT-5", input: 1.25, output: 10, cache_write: 0, cache_read: 0.125 },
  { match: ["gpt-4o-mini", "4o-mini"], label: "GPT-4o mini", input: 0.15, output: 0.6, cache_write: 0, cache_read: 0.075 },
  { match: ["gpt-4o", "chatgpt-4o", "4o"], label: "GPT-4o", input: 2.5, output: 10, cache_write: 0, cache_read: 1.25 },
  { match: ["gpt-4.1-nano", "4.1-nano"], label: "GPT-4.1 nano", input: 0.1, output: 0.4, cache_write: 0, cache_read: 0.025 },
  { match: ["gpt-4.1-mini", "4.1-mini"], label: "GPT-4.1 mini", input: 0.4, output: 1.6, cache_write: 0, cache_read: 0.1 },
  { match: ["gpt-4.1", "gpt-4.5"], label: "GPT-4.1", input: 2, output: 8, cache_write: 0, cache_read: 0.5 },
  // o3-mini reads cache at half its input rate; o4-mini and o1-mini at a
  // quarter. They shared a row and the difference was averaged away.
  { match: ["o3-mini"], label: "o3-mini", input: 1.1, output: 4.4, cache_write: 0, cache_read: 0.55 },
  { match: ["o4-mini", "o1-mini"], label: "o-mini", input: 1.1, output: 4.4, cache_write: 0, cache_read: 0.275 },
  { match: ["o1"], label: "o1", input: 15, output: 60, cache_write: 0, cache_read: 7.5 },
  { match: ["o3-deep-research"], label: "o3 deep research", input: 10, output: 40, cache_write: 0, cache_read: 2.5 },
  { match: ["o3-pro"], label: "o3-pro", input: 20, output: 80, cache_write: 0, cache_read: 0 },
  { match: ["o3"], label: "o3", input: 2, output: 8, cache_write: 0, cache_read: 0.5 },
  { match: ["gpt-4-turbo"], label: "GPT-4 Turbo", input: 10, output: 30, cache_write: 0, cache_read: 0 },
  { match: ["gpt-4"], label: "GPT-4", input: 30, output: 60, cache_write: 0, cache_read: 0 },
  { match: ["gpt-3.5"], label: "GPT-3.5", input: 0.5, output: 1.5, cache_write: 0, cache_read: 0 },

  // --- Google (Gemini) ---
  { match: ["gemini-2.5-pro", "gemini-1.5-pro"], label: "Gemini Pro", input: 1.25, output: 5, cache_write: 0, cache_read: 0.31 },
  { match: ["flash-lite"], label: "Gemini Flash-Lite", input: 0.075, output: 0.3, cache_write: 0, cache_read: 0.01875 },
  { match: ["gemini", "flash"], label: "Gemini Flash", input: 0.15, output: 0.6, cache_write: 0, cache_read: 0.0375 },

  // --- Moonshot AI (Kimi) ---
  // K3: cache misses use the normal input rate; cache hits are discounted 90%.
  // Flat across the whole 1M window — there is no long-context tier to add.
  { match: ["kimi-code/k3", "kimi-k3", "moonshot/k3"], exact: ["k3"], label: "K3", input: 3, output: 15, cache_write: 3, cache_read: 0.3 },

  // --- others (approx) ---
  { match: ["deepseek"], label: "DeepSeek", input: 0.27, output: 1.1, cache_write: 0, cache_read: 0.07 },
  { match: ["grok"], label: "Grok", input: 2, output: 10, cache_write: 0, cache_read: 0 },
  { match: ["mistral", "mixtral", "codestral"], label: "Mistral", input: 0.4, output: 2, cache_write: 0, cache_read: 0 },
  { match: ["llama"], label: "Llama", input: 0.2, output: 0.2, cache_write: 0, cache_read: 0 },
  { match: ["command"], label: "Command", input: 0.5, output: 1.5, cache_write: 0, cache_read: 0 },
];

let table = PRICE_TABLE;

// Allow a JSON override file so users tune prices without editing source.
try {
  const path = process.env.AGENTGLASS_PRICING;
  if (path) {
    const f = Bun.file(path);
    // top-level await is fine in Bun module scope
    const custom = (await f.json()) as ModelPrice[];
    if (Array.isArray(custom) && custom.length) table = custom;
  }
} catch (e) {
  console.warn("[pricing] failed to load AGENTGLASS_PRICING, using defaults:", e);
}

export function priceFor(modelName: string | null | undefined): ModelPrice | null {
  if (!modelName) return null;
  const m = modelName.toLowerCase();
  for (const p of table) {
    const exact = p.exact?.some((id) => m === id || m.startsWith(`${id}[`));
    if (exact || p.match.some((frag) => m.includes(frag))) return p;
  }
  return null;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * Whether the table actually has a rate for this model.
 *
 * costUsd() falls back to DEFAULT_PRICE — Sonnet-tier $3/$15 — for anything
 * it does not recognise, and returns that number with exactly the same
 * confidence as a real one. Nothing downstream could tell the two apart, so
 * a model the table has never heard of produced a spend figure that looked
 * measured. This is the question the dashboard needs in order to say so.
 *
 * Deliberately not "is this cost estimated": a source that reports its own
 * exact cost bypasses the table entirely (see reported_cost_usd), so the
 * honest, checkable statement is the narrower one — agentglass has no rate
 * for this model.
 */
export function hasPrice(modelName: string | null | undefined): boolean {
  return priceFor(modelName) !== null;
}

/** Cost in USD for a given usage + model. Unknown model → DEFAULT_PRICE. */
export function costUsd(usage: TokenUsage, modelName: string | null | undefined): number {
  const p = priceFor(modelName) ?? { ...DEFAULT_PRICE, match: [], label: "unknown" };
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cw = usage.cache_creation_tokens ?? 0;
  const cr = usage.cache_read_tokens ?? 0;
  return (
    (inTok * p.input +
      outTok * p.output +
      cw * p.cache_write +
      cr * p.cache_read) /
    1_000_000
  );
}

/**
 * What one token of each class costs, in uncached input tokens.
 *
 * A token is not a token. On Opus an output token costs five uncached input
 * tokens, a cache write costs 1.25 and a cache read costs a tenth — a spread of
 * fifty to one inside a single number the UI has been calling "tokens". Adding
 * them up produces a figure that is not comparable between two sessions, or
 * even between two turns of one session, and the direction of the error is not
 * predictable: a cache-heavy session looks enormous and is cheap.
 *
 * Weighting each class by its own price and expressing the result in the
 * cheapest one gives a number that *is* comparable, and that multiplies by a
 * single rate to give money — which is what makes it more useful than cost
 * alone, since cost moves whenever a provider changes its prices and this does
 * not.
 *
 * Input is 1 by definition. Everything else is a ratio, so the unit survives a
 * price table where every rate is doubled.
 */
export interface TokenWeights {
  output: number;
  cache_write: number;
  cache_read: number;
}

/**
 * The ratios for one model.
 *
 * A model with a free or absent input rate has no base to express anything in:
 * dividing by it gives Infinity, and a headline of Infinity is worse than the
 * raw sum it replaced. Those fall back to weights of 1, which is the same as
 * counting tokens the old way and is the honest answer when there is no price
 * to weight by — the caller can tell from `hasPrice` that the number is
 * unweighted.
 */
export function weightsFromPrice(p: Omit<ModelPrice, "match" | "label" | "exact">): TokenWeights {
  if (!(p.input > 0)) return { output: 1, cache_write: 1, cache_read: 1 };
  return { output: p.output / p.input, cache_write: p.cache_write / p.input, cache_read: p.cache_read / p.input };
}

export function weightsFor(modelName: string | null | undefined): TokenWeights {
  return weightsFromPrice(priceFor(modelName) ?? DEFAULT_PRICE);
}

/**
 * One comparable number for a usage row.
 *
 * `equivalentTokens(u, m) * priceFor(m).input / 1e6` is exactly `costUsd(u, m)`
 * when the model is priced — that identity is the point, and it is what a test
 * pins. Rounded, because a fractional token is not a thing and every consumer
 * formats it as a count.
 */
export function equivalentTokens(usage: TokenUsage, modelName: string | null | undefined): number {
  const w = weightsFor(modelName);
  return Math.round(
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) * w.output +
    (usage.cache_creation_tokens ?? 0) * w.cache_write +
    (usage.cache_read_tokens ?? 0) * w.cache_read
  );
}

/**
 * What to call a model on screen.
 *
 * This used to return `priceFor(m)?.label`, which welded display naming to
 * price bucketing — and those two want opposite things. A price row groups
 * several ids on purpose, because they share a rate; a name identifies one
 * model. So a GPT-5 session was labelled "GPT-4.1" by every server-rendered
 * surface (the cost donut) while the client-rendered ones (fleet card, session
 * chip, phone) called it "GPT-5", and modelColor() — which hashes the label —
 * drew the same model in two colours.
 *
 * Naming lives in shared/models.ts now, alongside providerOf, so both tiers
 * answer it identically. `ModelPrice.label` survives as the name of a *rate
 * row*, which is what it always really was: it names a bucket, not a model.
 */
export { modelLabelOf as modelLabel } from "../../shared/models.ts";
