/*
 * `g` then 1-9 opens the Nth starred row, for the tree and the folded rail alike. A pure step so the rule is tested as
 * behaviour: a field being typed in never counts, and nothing is taken while the Jira view is hidden (the board stays
 * mounted behind the PR, Git and Agents views).
 */
import { typingInto } from "../../lib/taskGrammar.ts";

export const GOTO_MS = 1500;

export interface GotoKey { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; target?: unknown }

/** What a keydown does: `arm` after `g`, the digit to jump to, or nothing. `at` is when `g` was pressed, 0 when not armed. */
export function gotoStep(e: GotoKey, at: number, now: number, active: boolean): { at: number; digit?: string } {
  if (!active || e.altKey || e.ctrlKey || e.metaKey) return { at: 0 };
  if (typingInto(e.target as { tagName?: string; isContentEditable?: boolean } | null)) return { at: 0 };
  if (e.key === "g") return { at: now };
  const armed = at > 0 && now - at < GOTO_MS;
  return armed && /^[1-9]$/.test(e.key) ? { at: 0, digit: e.key } : { at: 0 };
}
