/*
 * What the person is typing at the caret, in a JQL string: a field name, the operator a field takes, or a field's
 * value (quoted or not). A heuristic, not a parser for the whole grammar — it only has to be right about the word
 * under the caret, which is all an autocomplete box needs. ORDER BY's own field list reads the same as a clause's.
 */

export type JqlContext =
  | { kind: "field"; partial: string; start: number }
  | { kind: "operator"; field: string; partial: string; start: number }
  | { kind: "value"; field: string; partial: string; start: number; quoted: boolean };

/** A clause starts here: the string's start, after `(`, AND/OR/NOT, or ORDER BY. A bare comma is not one: outside quotes it only ever separates values in an `in (...)` list, which stays the value position. */
const BOUNDARY = /(^|\(|\b(?:and|or|not)\b|\border\s+by\b)\s*$/i;

/** Longest first, so "not in" is read whole rather than stopping at "in"; word operators need a boundary before them too. */
const OPERATORS = ["was not in", "was in", "was not", "is not", "not in", "changed", "in", "is", "was", "!=", ">=", "<=", "!~", "~", "=", ">", "<"];
/** Of those, the ones that open a value LIST: once inside their `(...)`, every comma-separated slot is still their value. */
export const LIST_OPERATORS = new Set(["in", "not in", "was in", "was not in"]);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lastOperator(rest: string, only?: Set<string>): { op: string; before: string } | null {
  for (const op of OPERATORS) {
    if (only && !only.has(op)) continue;
    const re = /^[a-z]/.test(op) ? new RegExp(`\\b${op}\\s*$`, "i") : new RegExp(`${esc(op)}\\s*$`);
    const m = re.exec(rest);
    if (m) return { op, before: rest.slice(0, m.index) };
  }
  return null;
}

/** The index of the nearest `(` before `at` that nothing between it and `at` has closed, or null with none open. */
function openParenAt(rest: string): number | null {
  let depth = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] === ")") depth++;
    else if (rest[i] === "(") { if (depth === 0) return i; depth--; }
  }
  return null;
}

/** The bare word right before `before`'s end, past a trailing `(`. */
const fieldBefore = (before: string): string => /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(before.replace(/\(\s*$/, ""))?.[1] ?? "";

/** The field a value belongs to, read from the text right before it: an operator just before it, else the bare word itself (a quote or a paren opened right after the field, with no operator typed — Jira reads that as `=`). */
function fieldOf(before: string): string {
  const trimmed = before.replace(/\s+$/, "");
  const op = lastOperator(trimmed);
  return fieldBefore(op ? op.before : trimmed);
}

/** The index just after an unclosed quote before `at`, or null when every quote up to there is closed. Escapes are not read: a query with `\"` in a value is rarer than one typed with the caret mid-string. */
function openQuoteAt(head: string): number | null {
  let open: number | null = null;
  let quote: string | null = null;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (quote) { if (c === quote) { quote = null; open = null; } }
    else if (c === '"' || c === "'") { quote = c; open = i; }
  }
  return quote ? open : null;
}

export function jqlCursorContext(text: string, cursor: number): JqlContext {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const q = openQuoteAt(head);
  if (q != null) {
    const before = head.slice(0, q);
    const pi = openParenAt(before.replace(/\s+$/, ""));
    const list = pi != null ? lastOperator(before.slice(0, pi).replace(/\s+$/, ""), LIST_OPERATORS) : null;
    const field = list ? fieldBefore(list.before) : fieldOf(before);
    return { kind: "value", field, partial: head.slice(q + 1), start: q + 1, quoted: true };
  }
  const partial = /[A-Za-z0-9_.[\]]*$/.exec(head)![0];
  const start = head.length - partial.length;
  const rest = head.slice(0, start);
  // A comma (or the paren itself) inside an open `in (...)`: still that field's value, however far from the `(`.
  const pi = openParenAt(rest);
  if (pi != null) {
    const list = lastOperator(rest.slice(0, pi).replace(/\s+$/, ""), LIST_OPERATORS);
    if (list) return { kind: "value", field: fieldBefore(list.before), partial, start, quoted: false };
  }
  const trimmed = rest.replace(/\s+$/, "");
  // An operator ending in a boundary word ("is NOT", "was NOT in") must win over the bare-NOT boundary below.
  const found = lastOperator(trimmed);
  if (found) return { kind: "value", field: fieldBefore(found.before), partial, start, quoted: false };
  if (!rest.trim().length || BOUNDARY.test(rest)) return { kind: "field", partial, start };
  return { kind: "operator", field: fieldBefore(trimmed), partial, start };
}
