/*
 * People in saved filters. A filter on a person is written with the site's account id (`assignee = "712020:..."`), which no
 * one should read. The name comes from, in order: the member the click held, the people on the loaded cards, and one
 * `GET /jira/user` per id still unknown, asked once per id for the session. An id nobody resolves reads "Person filter".
 *
 * Ceiling: only Cloud account ids (`123456:uuid`) and the 24-hex legacy ids are recognised; a Data Center login is a plain
 * word and cannot be told from a status name, so it is left as written.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";

/** The two shapes of id: `712020:5b10ac8d-82e0-4a41` and a bare 24-hex legacy id. */
export const ACCOUNT_ID = /\b\d+:[0-9a-f-]{8,}\b|\b[0-9a-f]{24}\b/gi;
export const PERSON_FILTER = "Person filter";

export const idsIn = (text: string): string[] => [...new Set(text.match(ACCOUNT_ID) ?? [])];

const names = new Map<string, string>();
/** Ids asked of the site this session (and refused ones too): never asked twice. */
const asked = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; for (const f of subs) f(); };

/** A name the page already holds for an id (a clicked member, a card's person). */
export function rememberPerson(id: string | undefined, name: string | undefined): void {
  if (!id || !name || names.get(id) === name) return;
  names.set(id, name);
  bump();
}
export const personName = (id: string): string | undefined => names.get(id);

/** The text with every id turned into a name; one nobody could resolve turns the whole text into "Person filter". */
export function readable(text: string, lookup: (id: string) => string | undefined = personName): string {
  const ids = idsIn(text);
  if (!ids.length) return text;
  if (ids.some((id) => !lookup(id))) return PERSON_FILTER;
  return text.replace(ACCOUNT_ID, (id) => lookup(id)!);
}

/** For a label, not a name: every id a person's name where one is known, "someone" where not; never the raw id. */
export function readableLabel(text: string, lookup: (id: string) => string | undefined = personName): string {
  return text.replace(ACCOUNT_ID, (id) => lookup(id) ?? "someone");
}

/** A name for a search saved in one click: the JQL cut where it is readable; a person's filter is the person. */
export function nameForQueryWith(jql: string, cut: (jql: string) => string, lookup: (id: string) => string | undefined = personName): string {
  const body = jql.replace(/\s+order\s+by\s+.*$/i, "").trim();
  const only = new RegExp("^(?:assignee|reporter)\\s*=\\s*[\"']?(" + ACCOUNT_ID.source + ")[\"']?$", "i").exec(body);
  if (only) return lookup(only[1]!) ?? PERSON_FILTER;
  const ids = idsIn(jql);
  return ids.length ? cut(readable(jql, lookup)) : cut(jql);
}

/** Seed from the people on cards, and ask the site for the ids in `texts` that are still unknown. */
export function usePersonNames(texts: readonly string[], people: readonly { key?: string; name: string }[] = []): (text: string) => string {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version, () => version);
  for (const p of people) if (p.key && !names.has(p.key)) names.set(p.key, p.name);
  const wanted = [...new Set(texts.flatMap(idsIn))].filter((id) => !names.has(id) && !asked.has(id));
  const key = wanted.join("\n");
  useEffect(() => {
    for (const id of wanted) {
      if (asked.has(id)) continue;
      asked.add(id);
      void api.jiraUser(id).then((r) => { if (r.ok && r.name) rememberPerson(id, r.name); }).catch(() => {});
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (text) => readable(text);
}
