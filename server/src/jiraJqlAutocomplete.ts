/*
 * What the JQL box offers while it is typed: the site's own field names, the operators and value types each one
 * takes, and its functions (Jira's `GET /jql/autocompletedata`); and, for one field as its value is typed, the
 * matching values or people (`GET /jql/autocompletedata/suggestions`) — the same route for both, since a user
 * field's suggestion already comes back as the quoted accountId JQL wants inserted, not a name.
 *
 * The field/operator/function list rarely changes: kept ten minutes like any other board read (`memoOk`). A typed
 * value is kept the `labelSuggestions` way: a short memo per query, the misses remembered too, so a letter undone
 * and retyped within the TTL costs nothing. Cloud only (`apiOf(creds) === 3`): Data Center's autocomplete route
 * answers a different shape, so there the box falls back to typing with no help, same as today.
 */
import { apiOf, jiraCall, memoOk, withStored, type JiraCreds, type JiraResult } from "./jira.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface JqlField { value: string; displayName: string; operators: string[]; types: string[]; cfid?: string }
export interface JqlFunction { value: string; displayName: string; isList: boolean; types: string[] }
export interface JqlAutocompleteData { fields: JqlField[]; functions: JqlFunction[] }

/** The site's JQL vocabulary: every field it can search on and what it takes, and every function. Cloud only. */
export function jqlAutocompleteData(creds: JiraCreds): Promise<JiraResult<JqlAutocompleteData>> {
  if (apiOf(creds) !== 3) return Promise.resolve({ ok: true, data: { fields: [], functions: [] } });
  return memoOk<JqlAutocompleteData>(creds, "jql-autocomplete", async () => {
    const r = await jiraCall<unknown>(creds, "/rest/api/3/jql/autocompletedata");
    if (!r.ok) return { ...r, data: undefined };
    const d = isObj(r.data) ? r.data : {};
    const fields = (Array.isArray(d.visibleFieldNames) ? d.visibleFieldNames : []).filter(isObj).flatMap((f): JqlField[] => {
      const value = str(f.value), displayName = str(f.displayName) || value;
      if (!value) return [];
      const cfid = str(f.cfid);
      return [{ value, displayName, operators: strs(f.operators), types: strs(f.types), ...(cfid ? { cfid } : {}) }];
    });
    const functions = (Array.isArray(d.visibleFunctionNames) ? d.visibleFunctionNames : []).filter(isObj).flatMap((f): JqlFunction[] => {
      const value = str(f.value), displayName = str(f.displayName) || value;
      return value ? [{ value, displayName, isList: bool(f.isList), types: strs(f.types) }] : [];
    });
    return { ok: true, data: { fields, functions } };
  });
}
export const jqlAutocompleteDataStored = (): Promise<JiraResult<JqlAutocompleteData>> => withStored(jqlAutocompleteData);

export interface JqlSuggestion { value: string; display: string }
const TAGS = /<\/?b>/g;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What a field's value may be, as typed: the raw text, already shaped as JQL wants it inserted (a quoted string, or
 * a quoted accountId for a user field) — `value` goes straight into the query, `display` (its bold markers stripped)
 * is what the row shows.
 */
export function jqlFieldSuggestions(creds: JiraCreds, fieldName: string, fieldValue: string): Promise<JiraResult<JqlSuggestion[]>> {
  if (apiOf(creds) !== 3 || !FIELD_NAME.test(fieldName)) return Promise.resolve({ ok: true, data: [] });
  const value = fieldValue.trim().slice(0, 64);
  return memoOk<JqlSuggestion[]>(creds, `jql-suggest:${fieldName}|${value.toLowerCase()}`, async () => {
    const path = `/rest/api/3/jql/autocompletedata/suggestions?${new URLSearchParams({ fieldName, fieldValue: value })}`;
    const r = await jiraCall<unknown>(creds, path);
    if (!r.ok) return { ...r, data: undefined };
    const rows = isObj(r.data) && Array.isArray(r.data.results) ? r.data.results.filter(isObj) : [];
    const out = rows.flatMap((x): JqlSuggestion[] => {
      const v = str(x.value);
      return v ? [{ value: v, display: (str(x.displayName) || v).replace(TAGS, "") }] : [];
    });
    return { ok: true, data: out.slice(0, 20) };
  }, true);
}
export const jqlFieldSuggestionsStored = (fieldName: string, fieldValue: string): Promise<JiraResult<JqlSuggestion[]>> =>
  withStored((c) => jqlFieldSuggestions(c, fieldName, fieldValue));
