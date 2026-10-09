/**
 * What plugins say about Inbox rows: a badge, a tip and a number to order by.
 *
 * A plugin posts them over its own token (`POST /plugin/self/inbox/annotations`)
 * and this module keeps the latest, in memory. Memory is enough: a plugin is a
 * process that starts with the server and posts again, and an annotation is
 * only ever a hint about a row that GitHub still owns.
 *
 * The rule the whole module exists to keep: it decorates and reorders, it
 * never removes. `annotate` returns the same rows in the same order, each with
 * at most a field added, so no plugin — buggy, hostile or merely wrong — can
 * make a notification vanish from the list.
 */
import {
  type Contributes, type InboxAnnotation, type InboxAnnotationInput,
  validateAnnotations,
} from "../../shared/pluginUi.ts";
import type { InboxItem } from "../../shared/types.ts";

/** Per plugin. A busy inbox is fifty rows; this is many pages of history. */
const KEEP = 1000;

const store = new Map<string, Map<string, InboxAnnotationInput>>();

export function setAnnotations(
  plugin: string,
  c: Contributes,
  raw: { items?: unknown; replace?: unknown },
): { ok: true; kept: number } | { ok: false; error: string } {
  if (!c.inboxAnnotations) return { ok: false, error: "inboxAnnotations is not declared in this plugin's manifest" };
  const v = validateAnnotations(raw.items ?? []);
  if (!v.ok) return v;
  let m = store.get(plugin);
  if (!m || raw.replace === true) store.set(plugin, (m = new Map()));
  for (const a of v.value) {
    // Re-inserted, so the map's order is "least recently posted first".
    m.delete(a.id);
    m.set(a.id, a);
  }
  while (m.size > KEEP) m.delete(m.keys().next().value as string);
  return { ok: true, kept: m.size };
}

/** A stopped or removed plugin leaves no badge behind. */
export function forgetAnnotations(plugin: string): void {
  store.delete(plugin);
}

/**
 * The rows with what plugins said about them added. Same rows, same order,
 * same count — an annotation for an older version of a row (`updatedAt` is not
 * the row's `at`) is not shown, since a new comment is a new question.
 */
export function annotate(items: InboxItem[]): InboxItem[] {
  if (store.size === 0) return items;
  return items.map((it) => {
    let list: InboxAnnotation[] | undefined;
    for (const [plugin, m] of store) {
      const a = m.get(it.id);
      if (!a || a.updatedAt !== it.at) continue;
      (list ??= []).push({
        plugin,
        ...(a.score !== undefined ? { score: a.score } : null),
        ...(a.rank !== undefined ? { rank: a.rank } : null),
        ...(a.badge ? { badge: a.badge } : null),
        ...(a.tip ? { tip: a.tip } : null),
      });
    }
    return list ? { ...it, annotations: list } : it;
  });
}

export function __resetAnnotations(): void { store.clear(); }
