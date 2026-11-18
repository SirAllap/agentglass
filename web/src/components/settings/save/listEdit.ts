// Add/remove rules for a list setting (launch deny rules). The stored format
// is ONE string, one item per line, and it does not change: parseList reads
// it, joinList writes it back exactly as before. Pure; the component saves
// the joined string through instantSave.
export type ListValidate = (item: string) => string | null;

export type Entry = { item: string; error: string | null };

/** Stored string -> items. Blank lines dropped, order kept, no dedupe of stored values. */
export function parseList(stored: string): string[] {
  return stored.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function joinList(list: string[]): string {
  return list.join("\n");
}

/** Every stored item, with its error if it is not a valid rule. Never filters:
 *  a stored invalid rule is shown marked and removable, and blocks nothing. */
export function entries(list: string[], validate?: ListValidate): Entry[] {
  return list.map((item) => ({ item, error: validate?.(item) ?? null }));
}

export type AddResult = { ok: true; list: string[] } | { ok: false; error: string };

/** Only the NEW item is validated; a bad one is not added. */
export function addItem(list: string[], raw: string, validate?: ListValidate): AddResult {
  const item = raw.trim();
  if (!item) return { ok: false, error: "Type a rule first" };
  const err = validate?.(item) ?? null;
  if (err) return { ok: false, error: err };
  if (list.includes(item)) return { ok: false, error: "Already in the list" };
  return { ok: true, list: [...list, item] };
}

export function removeItem(list: string[], item: string): string[] {
  return list.filter((x) => x !== item);
}
