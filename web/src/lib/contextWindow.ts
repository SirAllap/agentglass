/**
 * How large a model's context window is.
 *
 * This used to be a hardcoded table per call site, which drifts on every model
 * release and was silently wrong: a chat on `claude-opus-4-8[1m]` was measured
 * against 200k and rendered "237.0k / 200.0k · 100%" — an impossible reading
 * presented as a full bar. Three rules now decide the ceiling, in order, so a
 * model nobody has taught this file about still gets a defensible number.
 */

/** Windows that actually ship, smallest first. Used to round an observation up
 *  when the model turns out to be bigger than we assumed. */
const LADDER = [128_000, 200_000, 400_000, 1_000_000, 2_000_000];

/**
 * Claude Code's own notation for a non-default window, e.g. `claude-opus-4-8[1m]`
 * or `claude-sonnet-5[200k]`. Self-describing, so a future 1M variant needs no
 * change here — which is the whole point of preferring it over a name table.
 */
function suffixWindow(m: string): number | null {
  const hit = /\[(\d+)(k|m)\]/.exec(m);
  if (!hit) return null;
  const n = Number(hit[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return hit[2] === "m" ? n * 1_000_000 : n * 1_000;
}

/** Ceiling by model family. Only consulted when the id doesn't say outright. */
function familyWindow(m: string): number {
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("gpt-5")) return 400_000;
  if (m.includes("gpt") || /\bo[134]\b/.test(m)) return 128_000;
  return 200_000;  // every current Claude model, absent a suffix
}

/**
 * The context ceiling to measure `observed` tokens against.
 *
 * `observed` is the current prompt size. If it exceeds what the name implies,
 * the name is wrong — an alias we failed to resolve, a model newer than this
 * file, a window we misread — and the measurement is the harder evidence of the
 * two. Rather than clamp the bar to 100% and show a fraction greater than one,
 * promote the ceiling to the smallest real window that fits what we just saw.
 */
export function ctxLimitOf(model: string | null | undefined, observed = 0): number {
  const m = (model || "").toLowerCase();
  const named = suffixWindow(m) ?? familyWindow(m);
  if (observed <= named) return named;
  return LADDER.find((w) => w >= observed) ?? observed;
}
