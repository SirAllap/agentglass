/*
 * The people a search box is about, as chips.
 *
 * `author:erny` typed in the box is a person, and a person has a face: the bar
 * draws a complete token as a chip (avatar, login, a x) and leaves the rest of
 * the words in the field. Nothing is asked of anybody to do this: the face
 * comes from the same avatar the suggestions use and the logins from the
 * roster the panel already holds.
 *
 * A token is COMPLETE when more has been typed after it, or when the box was
 * not typed into just now (a picked person, a followed one, a recent search).
 * The word still under the caret is partial: it stays text, and is offered
 * people, because `author:er` may be on its way to `author:erny` or `erika`.
 *
 * Ceiling: only the three role qualifiers become chips; `involves:` and `@me`
 * stay text, and the order of a query is chips first, words after.
 */
export type PersonRole = "author" | "assignee" | "reviewer";
export interface PersonToken { role: PersonRole; login: string }

const TOKEN = /^(author|assignee|reviewer):"?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?)"?$/i;
const PARTIAL = /(?:^|\s)(author|assignee|reviewer):([\w-]*)$/i;

/** The text of a chip as the query spells it. */
export const tokenText = (t: PersonToken): string => `${t.role}:${t.login}`;

/** The box split into the chips it holds and the text left for the field. `editing`: the last word is still being typed. */
export function splitPersonTokens(query: string, editing: boolean): { people: PersonToken[]; rest: string } {
  const parts = query.split(/(\s+)/);
  const people: PersonToken[] = [];
  let rest = "";
  /* Only a word with nothing after it can still be growing: a space ends it. */
  const growing = editing && !/\s$/.test(query);
  const lastWord = parts.map((p, i) => (p.trim() ? i : -1)).filter((i) => i >= 0).pop();
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].trim() ? TOKEN.exec(parts[i]) : null;
    if (m && !(growing && i === lastWord)) {
      people.push({ role: m[1].toLowerCase() as PersonRole, login: m[2] });
      if (/^\s+$/.test(parts[i + 1] ?? "")) i++;
    } else rest += parts[i];
  }
  return { people, rest: rest.replace(/^\s+/, "") };
}

/** The inverse: the query the chips and the field's text make together. */
export function joinPersonTokens(people: readonly PersonToken[], rest: string): string {
  const head = people.map(tokenText).join(" ");
  return head && rest.trim() ? `${head} ${rest}` : head || rest;
}

/** The `role:name` word at the end of the text, still being typed. */
export function partialPerson(text: string): { role: PersonRole; token: string; start: number } | null {
  const m = PARTIAL.exec(text);
  if (!m) return null;
  return { role: m[1].toLowerCase() as PersonRole, token: m[2], start: text.length - m[2].length - m[1].length - 1 };
}

/** The partial word replaced by the complete token for the person picked, keeping the role it was typed with. */
export function completePerson(text: string, login: string): string {
  const p = partialPerson(text);
  return p ? `${text.slice(0, p.start)}${p.role}:${login} ` : text;
}
