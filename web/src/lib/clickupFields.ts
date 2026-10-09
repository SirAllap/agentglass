/*
 * Which custom field a board reads as "the PR link" and which it draws as a
 * colour swatch, as pure functions of the card's fields and the saved setting.
 *
 * Both used to be guesses from a team's vocabulary: a name containing "github",
 * a name containing squad/team/pod/tribe. A guess is the default, because it is
 * what the panel always did and a workspace that never opens Settings must see
 * no difference; a name typed into Settings replaces the guess for that field.
 * A name that is set and matches nothing on a card means the card has none,
 * rather than falling back to the guess: someone who named the field has said
 * which one it is.
 */
import type { ProviderTask } from "../../../shared/providers.ts";

type Field = NonNullable<ProviderTask["custom"]>[number];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The PR link a card carries in a custom field, or "". */
export function prLinkValue(custom: Field[] | undefined, field?: string): string {
  const f = (field ?? "").trim();
  const hit = f ? custom?.find((c) => same(c.name, f)) : custom?.find((c) => /github/i.test(c.name));
  return hit?.value ?? "";
}

/** The field a board shows as a swatch: the named one, else the first coloured
 *  one whose name sounds like a team, else the first coloured one. */
export function swatchField(custom: Field[] | undefined, field?: string): Field | undefined {
  const coloured = (custom ?? []).filter((c) => c.color);
  const f = (field ?? "").trim();
  if (f) return coloured.find((c) => same(c.name, f));
  return coloured.find((c) => /squad|team|pod|tribe/i.test(c.name)) ?? coloured[0];
}
