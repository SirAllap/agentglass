// Every formatter guards non-finite/nullish input: a single bad numeric field
// upstream (a divide-by-zero rate, a forged event) otherwise leaks "$NaN" or
// "Infinitys" straight into the UI.
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const neg = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a === 0) return "$0.00";
  if (a < 0.0001) return `${neg}<$0.0001`; // real spend that would round to $0.0000
  if (a >= 1) return `${neg}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${neg}$${a.toFixed(3)}`;
  return `${neg}$${a.toFixed(4)}`;
}

// Platform-aware modifier label: ⌘ only on actual Macs, Ctrl+ elsewhere.
export const MOD_KEY = /mac/i.test(typeof navigator !== "undefined" ? (navigator.platform ?? "") : "") ? "⌘" : "Ctrl+";

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms >= 3_600_000) { const h = ms / 3_600_000; return `${h.toFixed(h >= 10 ? 0 : 1)}h`; }
  if (ms >= 60_000) { const m = ms / 60_000; return `${m.toFixed(m >= 10 ? 0 : 1)}m`; }
  if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
  return Math.round(ms) + "ms";
}

export function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (!isFinite(d) || d < 1000) return "now"; // future/skewed stamps read as now
  if (d < 60_000) return Math.floor(d / 1000) + "s";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "m";
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h";
  return Math.floor(d / 86_400_000) + "d";
}

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false });

// Key on the full session id: two sessions of one app sharing an 8-char
// prefix would otherwise merge into one fleet card and one radar blip.
export const agentKey = (e: { source_app: string; session_id: string }) =>
  `${e.source_app}:${e.session_id}`;

/**
 * What to call a session on screen.
 *
 * A uuid is a correct identifier and a useless label: five agents on one repo
 * render as five near-identical hex strings, and picking the right one means
 * comparing characters. Claude Code already knows the answer — it writes an
 * `ai-title` for every session and a `custom-title` when you rename one — so
 * the fix is to use it.
 *
 * Precedence is the point: a rename is an explicit statement about what this
 * session is, so it beats the generated one even when the generated one is
 * newer. Falls back to `app:12345678` when there's no title at all, which is
 * every hook-only session (titles live in the transcript).
 */
export const sessionTitle = (
  s: { source_app?: string; session_id: string; custom_title?: string | null; ai_title?: string | null },
  max = 60
): string => {
  const t = (s.custom_title || s.ai_title || "").trim();
  if (t) return t.length > max ? t.slice(0, max - 1) + "…" : t;
  return s.source_app ? `${s.source_app}:${s.session_id.slice(0, 8)}` : s.session_id.slice(0, 8);
};

// Deterministic color from a string (agent lanes, model chips).
export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 70% 65%)`;
}

// Event-type accent colors.
export const TYPE_COLORS: Record<string, string> = {
  SessionStart: "#4ade80",
  SessionEnd: "#94a3b8",
  UserPromptSubmit: "#7c9cff",
  PreToolUse: "#38bdf8",
  PostToolUse: "#22d3ee",
  PostToolUseFailure: "#f87171",
  PermissionRequest: "#fbbf24",
  Notification: "#c084fc",
  SubagentStart: "#a3e635",
  SubagentStop: "#84cc16",
  Stop: "#94a3b8",
  PreCompact: "#fb923c",
};
export const typeColor = (t: string) => TYPE_COLORS[t] ?? "#64748b";

// Map a raw model_name to a short label, across providers:
// "claude-sonnet-5" → "Sonnet", "gpt-4o-2024-08-06" → "GPT-4o", "gemini-2.0-flash" → "Gemini Flash".
// First substring hit wins, so order specific → general. Unknown names pass through.
const MODEL_LABELS: [string, string][] = [
  ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"],
  ["gpt-4o-mini", "GPT-4o mini"], ["gpt-4o", "GPT-4o"], ["gpt-4.1", "GPT-4.1"],
  ["gpt-4", "GPT-4"], ["gpt-3.5", "GPT-3.5"], ["gpt-5-mini", "GPT-5 mini"], ["gpt-5", "GPT-5"],
  ["o4-mini", "o4-mini"], ["o3-mini", "o3-mini"], ["o1-mini", "o1-mini"], ["o1", "o1"], ["o3", "o3"],
  ["flash", "Gemini Flash"], ["gemini", "Gemini"],
  ["deepseek", "DeepSeek"], ["grok", "Grok"], ["mixtral", "Mistral"], ["mistral", "Mistral"],
  ["codestral", "Mistral"], ["llama", "Llama"], ["command", "Command"],
];
export function modelLabelOf(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const m = raw.toLowerCase();
  for (const [frag, label] of MODEL_LABELS) if (m.includes(frag)) return label;
  return raw;
}

// Coarse vendor for a model name — powers the provider filter/badge. Works for
// both Claude Code (model_name like "claude-opus-4-8") and OpenTelemetry sources.
export function providerOf(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const m = raw.toLowerCase();
  if (/opus|sonnet|haiku|fable|claude|anthropic/.test(m)) return "Anthropic";
  if (/gpt|davinci|openai|\bo1\b|\bo3\b|\bo4\b/.test(m)) return "OpenAI";
  if (/gemini|palm|bison|flash|google|vertex/.test(m)) return "Google";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/grok|xai/.test(m)) return "xAI";
  if (/mistral|mixtral|codestral/.test(m)) return "Mistral";
  if (/llama|meta-/.test(m)) return "Meta";
  if (/command|cohere/.test(m)) return "Cohere";
  return "unknown";
}

export const MODEL_COLORS: Record<string, string> = {
  Opus: "#f472b6",
  Sonnet: "#60a5fa",
  Haiku: "#34d399",
  Fable: "#c084fc",
  unknown: "#64748b",
};
export const modelColor = (m: string) => MODEL_COLORS[m] ?? hashColor(m);
