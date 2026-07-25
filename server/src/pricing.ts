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

export interface ModelPrice {
  match: string[]; // substrings matched against lowercased model_name
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

  // --- OpenAI (approx; verify at openai.com/pricing) ---
  { match: ["gpt-4o-mini", "4o-mini"], label: "GPT-4o mini", input: 0.15, output: 0.6, cache_write: 0, cache_read: 0.075 },
  { match: ["gpt-4o", "chatgpt-4o", "4o"], label: "GPT-4o", input: 2.5, output: 10, cache_write: 0, cache_read: 1.25 },
  { match: ["gpt-4.1-nano", "4.1-nano"], label: "GPT-4.1 nano", input: 0.1, output: 0.4, cache_write: 0, cache_read: 0.025 },
  { match: ["gpt-4.1-mini", "4.1-mini"], label: "GPT-4.1 mini", input: 0.4, output: 1.6, cache_write: 0, cache_read: 0.1 },
  { match: ["gpt-4.1", "gpt-5", "gpt-4.5"], label: "GPT-4.1", input: 2, output: 8, cache_write: 0, cache_read: 0.5 },
  { match: ["o4-mini", "o3-mini", "o1-mini"], label: "o-mini", input: 1.1, output: 4.4, cache_write: 0, cache_read: 0.275 },
  { match: ["o1"], label: "o1", input: 15, output: 60, cache_write: 0, cache_read: 7.5 },
  { match: ["o3"], label: "o3", input: 2, output: 8, cache_write: 0, cache_read: 0.5 },
  { match: ["gpt-4-turbo"], label: "GPT-4 Turbo", input: 10, output: 30, cache_write: 0, cache_read: 0 },
  { match: ["gpt-4"], label: "GPT-4", input: 30, output: 60, cache_write: 0, cache_read: 0 },
  { match: ["gpt-3.5"], label: "GPT-3.5", input: 0.5, output: 1.5, cache_write: 0, cache_read: 0 },

  // --- Google (Gemini) ---
  { match: ["gemini-2.5-pro", "gemini-1.5-pro"], label: "Gemini Pro", input: 1.25, output: 5, cache_write: 0, cache_read: 0.31 },
  { match: ["flash-lite"], label: "Gemini Flash-Lite", input: 0.075, output: 0.3, cache_write: 0, cache_read: 0.01875 },
  { match: ["gemini", "flash"], label: "Gemini Flash", input: 0.15, output: 0.6, cache_write: 0, cache_read: 0.0375 },

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
    if (p.match.some((frag) => m.includes(frag))) return p;
  }
  return null;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
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

export function modelLabel(modelName: string | null | undefined): string {
  const p = priceFor(modelName);
  return p?.label ?? (modelName ? modelName : "unknown");
}
