/*
 * What the Terminal's Commands popover decides, apart from drawing it.
 *
 * The popover has one filter box over everything it holds, so each section
 * asks the same question of the same text: do I show, and with what.
 */

/** The first row: the scrollback is searched with Find, and this is the way there for people who look in a commands list. */
export const SCROLLBACK_WORDS = "search the scrollback find buffer output history";

export function showScrollbackRow(query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || SCROLLBACK_WORDS.includes(q);
}

/** "2 of 5". */
export const pinCounter = (n: number, max: number): string => `${n} of ${max}`;

/** The empty slot, drawn dashed, only while nothing is pinned: it says what the section is for. */
export const showPinHole = (n: number): boolean => n === 0;

export interface PinRow {
  /** What is stored: a command line, `recipe:<id>`, or an encoded custom pin. */
  value: string;
  /** What the row reads. */
  label: string;
  /** The tooltip: the line that will run. */
  title: string;
  /** A saved command, which can ask for values. */
  recipeId?: string;
}

/**
 * One row per pin, in pin order, with a name a person would recognise.
 * A recipe whose list has not loaded yet reads as "Saved command" and not as
 * the `recipe:r1k2…` it is stored as.
 */
export function pinRows(
  pins: readonly string[],
  recipes: readonly { id: string; name: string }[],
  decode: (v: string) => { label: string; cmd: string } | null,
): PinRow[] {
  return pins.map((value) => {
    if (value.startsWith("recipe:")) {
      const id = value.slice("recipe:".length);
      const name = recipes.find((r) => r.id === id)?.name ?? "Saved command";
      return { value, label: name, title: `Run ${name}`, recipeId: id };
    }
    const c = decode(value);
    return c ? { value, label: c.label, title: `Run ${c.cmd}` } : { value, label: value, title: `Run ${value}` };
  });
}

/** Settings stays folded until there is something typed that it can answer. */
export const settingsOpen = (folded: boolean, query: string, matches: number): boolean =>
  query.trim() ? matches > 0 : !folded;
