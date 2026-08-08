/*
 * The keys a phone keyboard does not have.
 *
 * A software keyboard has letters and punctuation. A terminal needs Escape,
 * Tab, the arrows and the control characters, and without them the phone can
 * run `ls` and nothing else — no vim, no less, no interrupting a runaway
 * command, no history. This is the bar that closes that gap.
 *
 * The byte sequences are the ones every terminal has agreed on since VT100:
 * `\x1b` for Escape, `\x1b[A` for cursor-up, `\x03` for interrupt. They are
 * written out rather than computed because a table is checkable and a
 * generator is not — and the generator exists too, below, for the case a table
 * cannot cover.
 *
 * The order is the argument. The bar is one thumb wide and the row scrolls, so
 * whatever is left of the fold has to be what a person reaches for without
 * thinking. What that is was written down before anybody looked at the bar on a
 * phone: measured on a 411dp screen, six keys reach the fold and the order put
 * Esc, Tab, ⇧Tab, ↑ and ↓ in front of it — leaving ←, → and Ctrl+C, which the
 * same sentence called essential, behind the two pinned width pills.
 *
 * So it is reordered by what this app in particular needs, which is not what a
 * bare terminal needs. Ctrl+C comes third: it is the only key here that stops
 * something, and a key that stops something is worth more than a key that edits
 * a line. The arrows follow, and up/down before left/right, because up is
 * history and left/right are cursor movement inside a line — and this app edits
 * a line in the field below, where a thumb can see it, not on the pane. Those
 * two are the ones that can afford to be a swipe away.
 *
 * The arrows are also narrower than the rest. They are one glyph, they are the
 * keys pressed most, and 36dp buys a seventh key at the fold — so the visible
 * run is now the prefix, Esc, Ctrl+C, ↑, ↓, Tab and ⇧Tab.
 */

export interface AccessoryKey {
  id: string;
  label: string;
  /** Exactly what goes down the socket. */
  bytes: string;
  /** For a screen reader, and for anybody who does not read `⌫` as backspace. */
  spoken: string;
  /** Safe to fire repeatedly while held — the arrows and the deletes. Nothing
   *  that runs a command or changes a mode, because a stuck finger must not be
   *  able to send four interrupts. */
  repeatable?: boolean;
  /** One glyph, so it does not need a letter key's width. The trade is stated
   *  where the bar is drawn: 36dp instead of 44, which is under the 44dp tap
   *  target and buys the seventh key at the fold. */
  narrow?: boolean;
}

export const ACCESSORY_KEYS: AccessoryKey[] = [
  { id: "escape", label: "Esc", bytes: "\x1b", spoken: "Escape" },
  { id: "ctrlC", label: "^C", bytes: "\x03", spoken: "Interrupt" },
  { id: "up", label: "↑", bytes: "\x1b[A", spoken: "Arrow up", repeatable: true, narrow: true },
  { id: "down", label: "↓", bytes: "\x1b[B", spoken: "Arrow down", repeatable: true, narrow: true },
  { id: "tab", label: "Tab", bytes: "\t", spoken: "Tab" },
  // Terminal applications read ESC [ Z as reverse tab.
  { id: "shiftTab", label: "⇧Tab", bytes: "\x1b[Z", spoken: "Shift Tab" },
  { id: "left", label: "←", bytes: "\x1b[D", spoken: "Arrow left", repeatable: true, narrow: true },
  { id: "right", label: "→", bytes: "\x1b[C", spoken: "Arrow right", repeatable: true, narrow: true },
  { id: "ctrlD", label: "^D", bytes: "\x04", spoken: "End of file" },
  { id: "ctrlZ", label: "^Z", bytes: "\x1a", spoken: "Suspend" },
  { id: "ctrlL", label: "^L", bytes: "\x0c", spoken: "Clear screen" },
  { id: "ctrlR", label: "^R", bytes: "\x12", spoken: "Search history" },
  { id: "ctrlA", label: "^A", bytes: "\x01", spoken: "Start of line" },
  { id: "ctrlE", label: "^E", bytes: "\x05", spoken: "End of line" },
  { id: "ctrlW", label: "^W", bytes: "\x17", spoken: "Delete word" },
  { id: "ctrlU", label: "^U", bytes: "\x15", spoken: "Clear line" },
  { id: "ctrlK", label: "^K", bytes: "\x0b", spoken: "Clear to end of line" },
  { id: "backspace", label: "⌫", bytes: "\x7f", spoken: "Backspace", repeatable: true },
  { id: "delete", label: "Del", bytes: "\x1b[3~", spoken: "Forward delete", repeatable: true },
  { id: "home", label: "Home", bytes: "\x1b[H", spoken: "Home" },
  { id: "end", label: "End", bytes: "\x1b[F", spoken: "End" },
  { id: "pageUp", label: "PgUp", bytes: "\x1b[5~", spoken: "Page up", repeatable: true },
  { id: "pageDown", label: "PgDn", bytes: "\x1b[6~", spoken: "Page down", repeatable: true },
  { id: "enter", label: "⏎", bytes: "\r", spoken: "Enter" },
];

export type Modifier = "ctrl" | "alt" | "shift";

/**
 * A key the table does not have, built from its parts.
 *
 * The table covers what a bar can hold; this covers the rest — Ctrl+Alt+F7, or
 * Alt+B in a shell that binds it. Two encodings, and which one applies is not a
 * preference:
 *
 *   * A printable character with Ctrl becomes the control code for it: Ctrl+A
 *     is 0x01, and the arithmetic is "lowercase minus 96" for letters and a
 *     small table for the punctuation that also has one.
 *   * A cursor or function key with any modifier becomes CSI with a modifier
 *     parameter — `\x1b[1;5A` is Ctrl+Up — where the parameter is 1 plus a bit
 *     per modifier. That "1 plus" trips people: no modifiers is 1, not 0, and
 *     an unmodified key drops the parameter entirely.
 *
 * Alt is a prefixed Escape in both cases, which is what every terminal since
 * the VT220 has meant by "meta".
 */
const CSI_FINAL: Record<string, string> = {
  up: "A", down: "B", right: "C", left: "D", home: "H", end: "F",
  f1: "P", f2: "Q", f3: "R", f4: "S",
};

const CSI_TILDE: Record<string, number> = {
  insert: 2, delete: 3, pageUp: 5, pageDown: 6,
  f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};

/** Ctrl over the punctuation that has a control code. Letters are arithmetic. */
const CTRL_PUNCTUATION: Record<string, string> = {
  " ": "\x00", "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d",
  "^": "\x1e", "_": "\x1f", "?": "\x7f",
};

/** 1, plus a bit per modifier — xterm's encoding, and the "1" is not a typo. */
function modifierParameter(modifiers: Modifier[]): number {
  return 1
    + (modifiers.includes("shift") ? 1 : 0)
    + (modifiers.includes("alt") ? 2 : 0)
    + (modifiers.includes("ctrl") ? 4 : 0);
}

export function keyBytes(key: string, modifiers: Modifier[] = []): string | null {
  const alt = modifiers.includes("alt");
  const withAlt = (bytes: string): string => (alt ? `\x1b${bytes}` : bytes);
  const parameter = modifierParameter(modifiers);

  const final = CSI_FINAL[key];
  if (final) {
    // Unmodified F1–F4 are SS3 (ESC O P..S); once a modifier is present they
    // switch to the same CSI form the arrows use.
    if (parameter === 1) return key.startsWith("f") ? `\x1bO${final}` : `\x1b[${final}`;
    return `\x1b[1;${parameter}${final}`;
  }

  const tilde = CSI_TILDE[key];
  if (tilde) return parameter === 1 ? `\x1b[${tilde}~` : `\x1b[${tilde};${parameter}~`;

  if (key === "tab") {
    if (modifiers.includes("shift") && !modifiers.includes("ctrl")) return "\x1b[Z";
    return withAlt("\t");
  }
  if (key === "escape") return withAlt("\x1b");
  if (key === "enter") return withAlt("\r");
  if (key === "backspace") return withAlt(modifiers.includes("ctrl") ? "\b" : "\x7f");
  if (key === "space") return printable(" ", modifiers);

  if (key.length === 1 && key >= " " && key <= "~") return printable(key, modifiers);
  return null;
}

function printable(key: string, modifiers: Modifier[]): string | null {
  const shifted = modifiers.includes("shift") ? shift(key) : key;
  let bytes = shifted;
  if (modifiers.includes("ctrl")) {
    const lower = shifted.toLowerCase();
    const control = lower >= "a" && lower <= "z"
      ? String.fromCharCode(lower.charCodeAt(0) - 96)
      : CTRL_PUNCTUATION[shifted];
    // No control code for this character. Null rather than sending the plain
    // one: silently dropping the modifier types a letter where somebody meant
    // to send a command.
    if (control === undefined) return null;
    bytes = control;
  }
  return modifiers.includes("alt") ? `\x1b${bytes}` : bytes;
}

/**
 * tmux's prefix key, as tmux itself spells it.
 *
 * This is the one key on the bar that cannot be a constant. The prefix is
 * whatever the person set — `C-b` out of the box, and it was `C-f` on the first
 * machine this was ever pointed at — and a bar with the default on it is a
 * button that does nothing on any configured machine, which is worse than no
 * button because it looks like the feature is broken.
 *
 * The server reports it on the terminal socket (`{t:"tmux", prefix:["C-f"]}`),
 * so this only has to turn tmux's notation into bytes: `C-x` is Ctrl, `M-x` is
 * Meta/Alt, and both can stack.
 */
export function prefixKey(spec: string | undefined): AccessoryKey | null {
  if (!spec) return null;
  const modifiers: Modifier[] = [];
  let rest = spec.trim();
  // tmux writes the modifier prefixes in this order and repeats them for
  // combinations, e.g. `C-M-x`.
  for (;;) {
    if (/^C-/i.test(rest)) { modifiers.push("ctrl"); rest = rest.slice(2); continue; }
    if (/^M-/i.test(rest)) { modifiers.push("alt"); rest = rest.slice(2); continue; }
    if (/^S-/i.test(rest)) { modifiers.push("shift"); rest = rest.slice(2); continue; }
    break;
  }
  if (!rest) return null;
  const bytes = keyBytes(rest, modifiers);
  if (!bytes) return null;
  const label = modifiers.includes("ctrl") && modifiers.length === 1
    ? `^${rest.toUpperCase()}`
    : spec.toUpperCase();
  return { id: "tmuxPrefix", label, bytes, spoken: `tmux prefix, ${spec}` };
}

const SHIFTED: Record<string, string> = {
  "`": "~", 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*",
  9: "(", 0: ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
  ";": ":", "'": '"', ",": "<", ".": ">", "/": "?",
};

function shift(key: string): string {
  if (key >= "a" && key <= "z") return key.toUpperCase();
  return SHIFTED[key] ?? key;
}
