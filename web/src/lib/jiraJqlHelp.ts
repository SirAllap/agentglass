/*
 * What the JQL box's popover offers for one caret position, and what accepting a row does to the text. The lookup
 * of the site's vocabulary (api.jiraJqlAutocomplete, kept once per site connection) and of one field's values
 * (api.jiraJqlSuggest, debounced and aborted like any other typed search) live here too, away from the component,
 * so the choosing logic (buildCandidates) stays a pure function a test can drive with no screen.
 */
import { api } from "./api.ts";
import { jqlCursorContext, LIST_OPERATORS, type JqlContext } from "./jiraJqlContext.ts";

export interface JqlField { value: string; displayName: string; operators: string[]; types: string[] }
export interface JqlFunction { value: string; displayName: string; isList: boolean; types: string[] }
export interface JqlVocab { fields: JqlField[]; functions: JqlFunction[] }
export interface JqlCandidate { value: string; display: string; hint?: string }

const NO_VOCAB: JqlVocab = { fields: [], functions: [] };
/** A field with no operators of its own (Data Center, or one autocompletedata left out) still takes these. */
const FALLBACK_OPERATORS = ["=", "!=", "in", "not in", "is", "is not"];

let vocab: Promise<JqlVocab> | null = null;
/** The site's JQL vocabulary, read once and kept for this connection; a failed read is not kept, so the next box asks again. */
export function loadJqlVocab(): Promise<JqlVocab> {
  if (!vocab) {
    vocab = api.jiraJqlAutocomplete().then((r) => (r.ok ? { fields: r.fields ?? [], functions: r.functions ?? [] } : NO_VOCAB))
      .catch(() => NO_VOCAB);
    void vocab.then((v) => { if (v === NO_VOCAB) vocab = null; });
  }
  return vocab;
}
/** The site disconnected, or reconnected elsewhere: the next box reads fresh. */
export function __forgetJqlVocab(): void { vocab = null; }

const startsWith = (s: string, partial: string): boolean => !partial || s.toLowerCase().startsWith(partial.toLowerCase());
const fieldOf = (vocabIn: JqlVocab, name: string): JqlField | undefined =>
  vocabIn.fields.find((f) => f.value.toLowerCase() === name.toLowerCase() || f.displayName.toLowerCase() === name.toLowerCase());

/**
 * The rows the popover shows for this context: fields matching what is typed; a field's own operators (or the
 * fallback, for one autocompletedata left out); or, in value position, the site's own answers (already fetched,
 * handed in) followed by the functions whose type the field takes - `currentUser()` offered on `assignee`, not on
 * `summary`. Every list is capped; a box with fifty rows is not faster to read than ten.
 */
export function buildCandidates(ctx: JqlContext, v: JqlVocab, siteValues: readonly JqlCandidate[] = []): JqlCandidate[] {
  if (ctx.kind === "field") {
    return v.fields.filter((f) => startsWith(f.value, ctx.partial) || startsWith(f.displayName, ctx.partial))
      .slice(0, 30).map((f) => ({ value: f.value, display: f.displayName }));
  }
  if (ctx.kind === "operator") {
    const f = fieldOf(v, ctx.field);
    const ops = f && f.operators.length ? f.operators : ctx.field ? FALLBACK_OPERATORS : [];
    return ops.filter((op) => startsWith(op, ctx.partial)).map((op) => ({ value: op, display: op }));
  }
  const f = fieldOf(v, ctx.field);
  const fns = f
    ? v.functions.filter((fn) => fn.types.some((t) => f.types.includes(t)) && startsWith(fn.value, ctx.partial))
      .map((fn) => ({ value: fn.value, display: fn.displayName, hint: "function" }))
    : [];
  const values = siteValues.filter((s) => startsWith(s.display, ctx.partial) || startsWith(s.value, ctx.partial));
  const seen = new Set<string>();
  return [...values, ...fns].filter((c) => (seen.has(c.value) ? false : (seen.add(c.value), true))).slice(0, 30);
}

const unquote = (v: string): string =>
  (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) ? v.slice(1, -1) : v;

/**
 * The text after accepting `candidate` at this context: the partial word is replaced, never anything the person
 * typed around it. A field or operator leaves a trailing space (or `(` for a list operator) so the next key moves
 * straight into the next position; a quote the person already opened themselves is left exactly as they made it -
 * only the word inside it changes.
 */
export function applyJqlCandidate(text: string, ctx: JqlContext, candidate: JqlCandidate): { text: string; cursor: number } {
  const end = ctx.start + ctx.partial.length;
  const insert = ctx.kind === "value" && ctx.quoted ? unquote(candidate.value) : candidate.value;
  const trailing = ctx.kind === "field" ? " " : ctx.kind === "operator" ? (LIST_OPERATORS.has(candidate.value.toLowerCase()) ? " (" : " ") : "";
  const next = `${text.slice(0, ctx.start)}${insert}${trailing}${text.slice(end)}`;
  return { text: next, cursor: ctx.start + insert.length + trailing.length };
}

const SUGGEST_MS = 200;

/**
 * One field's values as typed, debounced and aborted like the search box's own site read: the caller gets the
 * answer for the LAST call only, never a stale one landing after a newer keystroke.
 */
export function suggestJqlValues(field: string, value: string, signal: AbortSignal): Promise<JqlCandidate[]> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      api.jiraJqlSuggest(field, value, signal).then((r) => resolve(r.ok ? (r.results ?? []).map((s) => ({ value: s.value, display: s.display })) : []))
        .catch(() => resolve([]));
    }, SUGGEST_MS);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve([]); }, { once: true });
  });
}

export { jqlCursorContext };
export type { JqlContext };
