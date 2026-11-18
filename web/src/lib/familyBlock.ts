/*
 * The Family, Dependencies and Related blocks of a card's panel: the umbrella it sits under with its siblings in Jira's order (Family),
 * what blocks it or is blocked by it (Dependencies), and every other link type (Related). Pure, so the rules can be asserted without a renderer. Nothing is invented: a dependency is a Jira issue link ("blocks",
 * "is blocked by", "depends on") or a key the card text names ("Depends on ORBIT-77") that resolves to a card we fetched; a key
 * that does not resolve is only "mentioned".
 */
import type { CardLinked, ProviderTask } from "../../../shared/providers.ts";
import { blockerWords } from "./blockers.ts";

const keyOf = (t: Pick<ProviderTask, "customId" | "id">): string => t.customId ?? t.id;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export type DepWay = "blockedBy" | "blocks";

/** Which way a link's phrase points for THIS card; null for a link that orders nothing ("relates to"). */
export function wayOf(phrase: string): DepWay | null {
  const p = phrase.trim().toLowerCase();
  if (/is depended on by|is required by|is a blocker|^blocks\b/.test(p)) return "blocks";
  if (/blocked by|^depends on|is dependent on|^requires\b|^waits on/.test(p)) return "blockedBy";
  return null;
}

export interface UmbrellaInfo {
  key: string; title: string; type?: string | undefined; status: string; statusKind: ProviderTask["statusKind"] | null; color?: string | undefined;
  /** Sub-tasks done and in all; null while the umbrella's own read has not come. */
  progress: { done: number; total: number } | null;
}
export interface SiblingRow { key: string; id: string; task: ProviderTask; current: boolean }
export interface DepRow {
  way: DepWay; key: string; title: string; status: string; statusKind: ProviderTask["statusKind"]; resolved: boolean;
  /** A Jira link, or a key the card text names that resolves. */
  via: "link" | "text"; from: "card" | "umbrella"; phrase: string;
}
/** Links that order nothing ("relates to", "duplicates", "clones"...), under the site's own phrase for this card's side. */
export interface RelatedRow { key: string; title: string; status: string; statusKind: ProviderTask["statusKind"]; resolved: boolean; phrase: string; type: string }
export interface RelatedGroup { phrase: string; rows: RelatedRow[] }
export interface FamilyModel {
  umbrella: UmbrellaInfo | null;
  siblings: SiblingRow[];
  /** The card's own sub-tasks, in Jira's order, when it is a parent. */
  children: SiblingRow[];
  deps: DepRow[];
  /** Every other link type, grouped by phrase in the site's order; one card under two types shows under each. */
  related: RelatedGroup[];
  /** Keys the text names that are not in what was fetched: shown as plain text. */
  mentioned: string[];
  /** "Blocked by ORBIT-77 (In development) - don't merge alone": only for a real Jira link whose blocker is not done. */
  warning: string | null;
  /** "Part of ORBIT-123: 3 sibling cards still open"; `alert` only when a real blocker exists. */
  hint: { text: string; alert: boolean } | null;
}

export interface FamilyInput {
  card: ProviderTask;
  /** The card's own `linked` and description, from its read. */
  linked?: readonly CardLinked[] | undefined;
  description?: string | undefined;
  /** The card's own sub-tasks, from its read. */
  subtasks?: readonly ProviderTask[] | undefined;
  /** The umbrella's own read (its task, sub-tasks in Jira's order, links), once fetched. */
  parent?: { task: ProviderTask; subtasks: readonly ProviderTask[]; linked?: readonly CardLinked[] | undefined } | null | undefined;
}

const isSub = (t: Pick<ProviderTask, "issueType">): boolean => /^sub-?task$/i.test((t.issueType ?? "").replace(/\s+/g, ""));

/** Keys a card's text names as a dependency ("Depends on ORBIT-77", "blocked by ORBIT-80"). */
export function mentionedKeys(text: string | undefined, self: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/\b(?:depends on|blocked by|waiting on|waits on|after)\s+(?:the\s+)?([A-Z][A-Z0-9]+-\d+)\b/gi)) {
    const k = m[1]!.toUpperCase();
    if (!same(k, self) && !out.includes(k)) out.push(k);
  }
  return out;
}

export function familyBlockOf(i: FamilyInput): FamilyModel {
  const self = keyOf(i.card);
  const pr = i.parent ?? null;
  const subs = pr?.subtasks ?? [];
  const hasUmbrella = isSub(i.card) && !!i.card.parent;
  const umbrella: UmbrellaInfo | null = hasUmbrella
    ? {
        key: i.card.parent!.key, title: pr?.task.title ?? i.card.parent!.title, type: pr?.task.issueType ?? i.card.parent!.type,
        status: pr?.task.status ?? "", statusKind: pr?.task.statusKind ?? null, color: pr?.task.statusColor,
        progress: pr ? { done: subs.filter((s) => s.statusKind === "done").length, total: subs.length } : null,
      }
    : null;
  const siblings: SiblingRow[] = hasUmbrella ? subs.map((t) => ({ key: keyOf(t), id: t.id, task: t, current: same(keyOf(t), self) || t.id === i.card.id })) : [];

  const children: SiblingRow[] = (i.subtasks ?? []).map((t) => ({ key: keyOf(t), id: t.id, task: t, current: false }));

  const deps: DepRow[] = [];
  const known = new Map<string, ProviderTask>();
  const related: RelatedGroup[] = [];
  const take = (links: readonly CardLinked[] | undefined, from: DepRow["from"]) => {
    for (const l of links ?? []) {
      known.set(keyOf(l.task).toUpperCase(), l.task);
      const way = wayOf(l.phrase);
      if (!way) {
        if (from !== "card") continue;
        const row: RelatedRow = { key: keyOf(l.task), title: l.task.title, status: l.task.status, statusKind: l.task.statusKind, resolved: l.task.statusKind === "done", phrase: l.phrase, type: l.type };
        const g = related.find((x) => x.phrase === l.phrase);
        if (g) g.rows.push(row); else related.push({ phrase: l.phrase, rows: [row] });
        continue;
      }
      deps.push({ way, key: keyOf(l.task), title: l.task.title, status: l.task.status, statusKind: l.task.statusKind, resolved: l.task.statusKind === "done", via: "link", from, phrase: l.phrase });
    }
  };
  take(i.linked, "card");
  take(pr?.linked, "umbrella");
  for (const s of subs) known.set(keyOf(s).toUpperCase(), s);
  if (pr) known.set(keyOf(pr.task).toUpperCase(), pr.task);

  const mentioned: string[] = [];
  for (const k of mentionedKeys(i.description, self)) {
    if (deps.some((d) => same(d.key, k))) continue;
    const t = known.get(k);
    if (t) deps.push({ way: "blockedBy", key: keyOf(t), title: t.title, status: t.status, statusKind: t.statusKind, resolved: t.statusKind === "done", via: "text", from: "card", phrase: "mentioned in the text" });
    else mentioned.push(k);
  }

  const blockers = deps.filter((d) => d.way === "blockedBy" && d.via === "link" && !d.resolved);
  const blocker = blockers[0];
  const warning = blockerWords(blockers)?.chip ?? null;
  const open = siblings.filter((s) => !s.current && s.task.statusKind !== "done").length;
  const hint = umbrella && umbrella.statusKind !== "done" && open > 0
    ? { text: `Part of ${umbrella.key}: ${open} sibling ${open === 1 ? "card" : "cards"} still open`, alert: !!blocker }
    : null;
  return { umbrella, siblings, children, deps, related, mentioned, warning, hint };
}

/** The card key one step along the siblings (-1 previous, 1 next); null at either end or when this card is not among them. */
export function siblingStep(siblings: readonly SiblingRow[], way: -1 | 1): string | null {
  const at = siblings.findIndex((s) => s.current);
  if (at < 0) return null;
  return siblings[at + way]?.key ?? null;
}

/** Whether the block shows its full body: what the person chose wins, else open only when something blocks. */
export function familyOpen(stored: string | null, m: FamilyModel): boolean {
  if (stored === "open") return true;
  if (stored === "compact") return false;
  return m.warning !== null;
}

/** Each block shows only when it has something: no empty box. Family is the parent / sub-tasks / siblings only. */
export const hasFamily = (m: FamilyModel): boolean => !!m.umbrella || m.children.length > 0;
export const hasDependencies = (m: FamilyModel): boolean => m.deps.length > 0 || m.mentioned.length > 0;
export const hasRelated = (m: FamilyModel): boolean => m.related.length > 0;
export const familyHasContent = (m: FamilyModel): boolean => hasFamily(m) || hasDependencies(m) || hasRelated(m);
