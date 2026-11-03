/*
 * The tmux prefix, mirrored without a clock.
 *
 * The prefix arms on the chord and the very next key decides what it was for:
 * a digit 1-9 picks that window, `c` opens a new one (tmux's own keys: `n` is
 * next-window there, and the strip does not take it away), and anything else — Esc
 * included — or a pointer press puts it down. There is no timeout: tmux waits
 * as long as the person does, and a mark that expires by itself reports a
 * state tmux is still in. It is a best-effort mirror, not a model of tmux: the
 * same byte is also what goes THROUGH to a nested tmux or an application, so
 * the prefix chord pressed while armed is read as that literal prefix and
 * disarms rather than re-arming.
 *
 * Meta prefixes (`M-a`) arrive as escape plus the key in one chunk, so a chunk
 * is compared whole: a paste that merely contains the byte does not arm.
 */

/** The byte a terminal sends for a key spelled the way tmux spells it.
 *  Only the two forms a prefix is ever bound to: `C-x` (the control byte) and
 *  `M-x` (escape then the key). Anything else is null and simply never matches,
 *  which is the right failure — a missing indicator, not a wrong one. */
export function prefixByte(k: string): string | null {
  const m = /^([CM])-(.)$/.exec(k);
  if (!m) return null;
  const [, mod, ch] = m;
  if (mod === "C") {
    const code = ch!.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code & 0x1f) : null;
  }
  return "\u001b" + ch;
}

export type PrefixEvent = { type: "key"; data: string } | { type: "pointer" };
export type PrefixAction = { type: "select"; n: number } | { type: "new" };
export interface PrefixStep { armed: boolean; action: PrefixAction | null }

/** One event in, the new armed state and the thing the key was for out. */
export function prefixStep(armed: boolean, ev: PrefixEvent, prefix: readonly string[]): PrefixStep {
  const down: PrefixStep = { armed: false, action: null };
  if (ev.type !== "key") return down;
  const isPrefix = prefix.some((k) => prefixByte(k) === ev.data);
  if (!armed) return isPrefix ? { armed: true, action: null } : down;
  if (/^[1-9]$/.test(ev.data)) return { armed: false, action: { type: "select", n: Number(ev.data) } };
  if (ev.data === "c") return { armed: false, action: { type: "new" } };
  return down;
}
