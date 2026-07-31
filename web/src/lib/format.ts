// Every formatter guards non-finite/nullish input: a single bad numeric field
// upstream (a divide-by-zero rate, a forged event) otherwise leaks "$NaN" or
// "Infinitys" straight into the UI.
/**
 * How many decimals a dollar figure needs to stop lying.
 *
 * Two cents needs two; four hundredths of a cent needs four, or it renders as
 * "$0.00" and the panel claims nothing was spent. Exported because the hero
 * KPI cannot use fmtUsd — it feeds a NumberFlow, which animates a *number* and
 * takes Intl options rather than a formatted string — and the two renderings
 * of the same field disagreeing is the bug this exists to prevent.
 */
export function usdDigits(n: number): number {
  const a = Math.abs(n);
  return a === 0 || a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
}

// Every formatter guards non-finite/nullish input: a single bad numeric field
// upstream (a divide-by-zero rate, a forged event) otherwise leaks "$NaN".
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const neg = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a === 0) return "$0.00";
  if (a < 0.0001) return `${neg}<$0.0001`; // real spend that would round to $0.0000
  return `${neg}$${a.toFixed(usdDigits(a))}`;
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

/**
 * What a weighted token count is called, and what it means, said once.
 *
 * A token is not a token: an output token on Opus costs five uncached input
 * tokens and a cache read costs a tenth, so the "tokens" this app used to show
 * — `input + output`, cache dropped — was not a quantity you could compare
 * between two sessions, and the error did not even point one way.
 *
 * Everything spend-shaped now shows the same weighted figure, and everything
 * says `eq` rather than `tok`, because a number that has stopped being a count
 * of tokens should stop being labelled as one. The suffix is short enough for a
 * chip; the sentence below is what a reader gets on hover, and it is the same
 * sentence everywhere — eight call sites each explaining this in their own
 * words is how three of them end up explaining it wrongly.
 */
export const EQ_SUFFIX = "eq";

export function eqTitle(n: number | null | undefined): string {
  const exact = n == null || !isFinite(n) ? "unknown" : Math.round(n).toLocaleString();
  return `${exact} input-equivalent tokens — every class weighted by its own price ` +
    `(on Opus an output token counts as 5, a cache write 1.25, a cache read 0.1), ` +
    `so this is comparable between sessions and models in a way a raw token count is not.`;
}

/** The figure and its unit: "4.2M eq". */
export const fmtEq = (n: number | null | undefined): string => `${fmtTokens(n)} ${EQ_SUFFIX}`;

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

/** fmtAgo as a sentence. It answers "now" under a second, and "now ago" is not
 *  English — which is exactly the value a "last seen" row shows right after the
 *  thing it is describing happened. */
export function since(ts: number): string {
  const d = fmtAgo(ts);
  return d === "now" ? "just now" : `${d} ago`;
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
  s: {
    source_app?: string; session_id: string;
    custom_title?: string | null; ai_title?: string | null; first_prompt?: string | null;
  },
  max = 60
): string => {
  const t = (s.custom_title || s.ai_title || "").trim();
  if (t) return clipTitle(t, max);
  // What you first asked for, when nobody ever named it. A uuid identifies a
  // session and describes nothing, and on a real machine most rows have no
  // title at all — a list of thirty reading `agentglass:cd3fa401` cannot be
  // scanned by eye, which is the same as not having a list.
  const p = promptTitle(s.first_prompt);
  if (p) return clipTitle(p, max);
  return s.source_app ? `${s.source_app}:${s.session_id.slice(0, 8)}` : s.session_id.slice(0, 8);
};

/**
 * A prompt, reduced to something that reads as a name.
 *
 * The first line is almost always the ask; what follows is context, pasted
 * output or a checklist, and none of it belongs in a row 300px wide. Fenced
 * blocks and quoted material are skipped for the same reason — a prompt that
 * opens with a stack trace would otherwise be titled with one.
 */
export function promptTitle(prompt: string | null | undefined): string {
  if (!prompt) return "";
  let inFence = false;
  for (const raw of prompt.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    // Slash commands, quotes and markup are not what the session is about.
    if (line.startsWith(">") || line.startsWith("#") || line.startsWith("<")) continue;
    return line.replace(/\s+/g, " ");
  }
  return "";
}

const clipTitle = (t: string, max: number): string =>
  t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;

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

// Both of these used to live here in full, with a second copy of providerOf in
// server/src/db.ts and a rival label table in server/src/pricing.ts. They are
// one implementation now — see shared/models.ts for why the label had to stop
// coming from the price row it matched.
export { modelLabelOf, providerOf } from "../../../shared/models.ts";

export const MODEL_COLORS: Record<string, string> = {
  Opus: "#f472b6",
  Sonnet: "#60a5fa",
  Haiku: "#34d399",
  Fable: "#c084fc",
  unknown: "#64748b",
};
export const modelColor = (m: string) => MODEL_COLORS[m] ?? hashColor(m);
