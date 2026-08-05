// What a model is called, and who makes it. One copy, both tiers.
//
// These two questions used to be answered three times: `providerOf` in
// server/src/db.ts and again in web/src/lib/format.ts, and the display label
// in web/src/lib/format.ts and — separately and differently — in
// server/src/pricing.ts, where `modelLabel()` returned the matched price row's
// name.
//
// That last one is the reason this file exists. A price row deliberately
// buckets several model ids together, because several models can share a rate;
// a label must not, because a name identifies one model. Welding them meant the
// donut called a GPT-5 session "GPT-4.1" while the fleet card beside it called
// the same session "GPT-5" — and, since modelColor() hashes the label string,
// drew them in two different colours. Naming is now decided here and pricing in
// pricing.ts, and neither can drift into the other.
//
// Kept deliberately dumb — substring matching, first hit wins, order specific
// to general — because it runs per event on the ingest path.

/** Raw fragment → display label. Order matters: specific before general. */
const MODEL_LABELS: [string, string][] = [
  ["kimi-code/k3", "K3"], ["kimi-k3", "K3"], ["moonshot/k3", "K3"],
  ["minimax-m2.7", "MiniMax M2.7"], ["minimax-m3", "MiniMax M3"], ["minimax", "MiniMax"],
  ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"],
  ["mythos", "Mythos"],
  ["gpt-4o-mini", "GPT-4o mini"], ["gpt-4o", "GPT-4o"],
  ["gpt-4.1-nano", "GPT-4.1 nano"], ["gpt-4.1-mini", "GPT-4.1 mini"], ["gpt-4.1", "GPT-4.1"],
  ["gpt-5-nano", "GPT-5 nano"], ["gpt-5-mini", "GPT-5 mini"], ["gpt-5", "GPT-5"],
  ["gpt-4.5", "GPT-4.5"],
  ["gpt-4-turbo", "GPT-4 Turbo"], ["gpt-4", "GPT-4"], ["gpt-3.5", "GPT-3.5"],
  ["o4-mini", "o4-mini"], ["o3-mini", "o3-mini"], ["o1-mini", "o1-mini"], ["o1", "o1"], ["o3", "o3"],
  ["flash", "Gemini Flash"], ["gemini", "Gemini"],
  ["deepseek", "DeepSeek"], ["grok", "Grok"], ["mixtral", "Mistral"], ["mistral", "Mistral"],
  ["codestral", "Mistral"], ["llama", "Llama"], ["command", "Command"],
];

/** What the miss bucket is called. The server stores NULL for it; see
 *  UNKNOWN_PROVIDER in server/src/db.ts for why the two must correspond. */
export const UNKNOWN = "unknown";

/**
 * A raw model_name as a short display label.
 *
 * "claude-sonnet-5" → "Sonnet", "gpt-4o-2024-08-06" → "GPT-4o",
 * "gemini-2.0-flash" → "Gemini Flash". An unrecognised name passes through
 * unchanged rather than becoming "unknown": a model this table has not learned
 * yet is still better identified by its own id than by a shrug.
 */
export function modelLabelOf(raw: string | null | undefined): string {
  if (!raw) return UNKNOWN;
  const m = raw.toLowerCase();
  // K3 arrives bare or with a context suffix — `k3[512k]` is the same model.
  if (m === "k3" || m.startsWith("k3[")) return "K3";
  for (const [frag, label] of MODEL_LABELS) if (m.includes(frag)) return label;
  return raw;
}

/** Coarse vendor for a model name — powers the provider filter and badge.
 *  Works for Claude Code's `claude-opus-4-8` and for OpenTelemetry sources. */
export function providerOf(raw: string | null | undefined): string {
  if (!raw) return UNKNOWN;
  const m = raw.toLowerCase();
  if (/opus|sonnet|haiku|fable|claude|anthropic/.test(m)) return "Anthropic";
  if (/gpt|davinci|openai|\bo1\b|\bo3\b|\bo4\b/.test(m)) return "OpenAI";
  if (/gemini|palm|bison|flash|google|vertex/.test(m)) return "Google";
  if (/kimi|moonshot/.test(m) || m === "k3" || m.startsWith("k3[")) return "Moonshot";
  if (/minimax/.test(m)) return "MiniMax";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/grok|xai/.test(m)) return "xAI";
  if (/mistral|mixtral|codestral/.test(m)) return "Mistral";
  if (/llama|meta-/.test(m)) return "Meta";
  if (/command|cohere/.test(m)) return "Cohere";
  return UNKNOWN;
}
