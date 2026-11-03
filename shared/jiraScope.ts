/*
 * The cards of one place in the Jira tree, as a view that is never stored.
 *
 * Picking a space, a component, an epic or "No epic" in the tree shows its cards
 * in the centre pane. That pane reads views by id, so the place is named by an id
 * (`scope:INF`, `scope:INF|c:Network`, `scope:INF|c:`, `scope:INF|e:INF-12`,
 * `scope:INF|c:Network|n`) and the server turns it into a search. Nothing is
 * written to the address book: a place is not something the person added.
 *
 * Ceiling: an epic is a card's `parent` (Cloud's epic link). A Data Center site
 * that still files cards under an "Epic Link" field shows an epic with no cards.
 */
export interface Scope { space: string; component?: string; epic?: string; noEpic?: boolean }

const SPACE = /^[A-Z][A-Z0-9_]{0,19}$/;
const EPIC = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
export const SCOPE_PREFIX = "scope:";
/** "" is the cards with no component. */
const COMPONENT_MAX = 80;

export function scopeId(s: Scope): string {
  const parts = [`${SCOPE_PREFIX}${s.space}`];
  if (s.component !== undefined) parts.push(`c:${s.component}`);
  if (s.epic) parts.push(`e:${s.epic}`);
  if (s.noEpic) parts.push("n");
  return parts.join("|");
}

/** Null for anything that is not an id this file wrote; a hand-made id never reaches a query. */
export function parseScope(id: string): Scope | null {
  if (!id.startsWith(SCOPE_PREFIX)) return null;
  const [head, ...rest] = id.slice(SCOPE_PREFIX.length).split("|");
  if (!head || !SPACE.test(head)) return null;
  const out: Scope = { space: head };
  for (const p of rest) {
    if (p.startsWith("c:") && out.component === undefined) {
      const name = p.slice(2);
      if (name.length > COMPONENT_MAX || /[\u0000-\u001f]/.test(name)) return null;
      out.component = name;
    } else if (p.startsWith("e:") && !out.epic && EPIC.test(p.slice(2))) out.epic = p.slice(2);
    else if (p === "n" && !out.noEpic) out.noEpic = true;
    else return null;
  }
  return out;
}

const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The search a place is: its cards, newest change first. Sub-tasks stay under their parents, so they are left out. */
export function scopeJql(s: Scope): string {
  const where = [`project = ${s.space}`, "issuetype != Epic"];
  if (s.component !== undefined) where.push(s.component ? `component = ${quote(s.component)}` : "component is EMPTY");
  if (s.epic) where.push(`parent = ${s.epic}`);
  if (s.noEpic) where.push("parent is EMPTY");
  return `${where.join(" AND ")} ORDER BY updated DESC`;
}

export function scopeName(s: Scope, componentLabel = "No component"): string {
  const bits = [s.space];
  if (s.component !== undefined) bits.push(s.component || componentLabel);
  bits.push(s.epic ? s.epic : s.noEpic ? "No epic" : "");
  return bits.filter(Boolean).join(" · ");
}
