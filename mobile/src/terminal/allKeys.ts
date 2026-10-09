/*
 * "All keys": the sheet behind the bar's fixed `⋯`.
 *
 * The bar holds the keys pressed all day and scrolls; the rest of a terminal's
 * keys — control chords, movement, the punctuation a phone keyboard buries
 * three layers down, F1 to F12 — used to be a swipe away or not there at all.
 * They are a grid now, and the grid sends what the bar sends.
 *
 * ONE source of bytes. A key that is on the bar is taken from `ACCESSORY_KEYS`
 * by id rather than written again, so the sheet cannot disagree with the bar
 * about what ^C is; the keys the catalogue does not have (Ins, F1-F12 and the
 * symbols) are built by `keyBytes`, the encoder the tmux prefix and the
 * modifier latches already go through. Every key carries its `key` name, so a
 * latched Ctrl or Shift composes through `sendFor` exactly as it does on the
 * bar and is refused exactly where the bar refuses it.
 *
 * The catalogue itself is not extended: its order is what a saved layout
 * (`keyLayout.ts`) was written against, and a key added to it would move
 * somebody's bar.
 */
import { ACCESSORY_KEYS, keyBytes, type AccessoryKey } from "./keys.ts";

export interface KeyGroup {
  id: "control" | "move" | "symbols" | "function";
  title: string;
  keys: AccessoryKey[];
}

function fromBar(ids: readonly string[]): AccessoryKey[] {
  return ids.map((id) => {
    const key = ACCESSORY_KEYS.find((k) => k.id === id);
    if (!key) throw new Error(`the key bar has no key called ${id}`);
    return key;
  });
}

function built(id: string, label: string, name: string, spoken: string): AccessoryKey {
  const bytes = keyBytes(name);
  if (bytes === null) throw new Error(`no encoding for ${name}`);
  return { id, label, bytes, key: name, spoken };
}

const SYMBOLS: [string, string, string][] = [
  ["pipe", "|", "Pipe"], ["tilde", "~", "Tilde"], ["slash", "/", "Slash"], ["backslash", "\\", "Backslash"],
  ["dash", "-", "Dash"], ["underscore", "_", "Underscore"], ["backtick", "`", "Backtick"], ["dollar", "$", "Dollar"],
];

export const ALL_KEYS: readonly KeyGroup[] = [
  { id: "control", title: "Control", keys: fromBar(["ctrlC", "ctrlD", "ctrlZ", "ctrlL", "ctrlR", "ctrlA", "ctrlE", "ctrlW"]) },
  {
    id: "move", title: "Move",
    keys: [
      ...fromBar(["home", "end", "pageUp", "pageDown", "shiftTab", "delete"]),
      built("insert", "Ins", "insert", "Insert"),
      ...fromBar(["enter"]),
    ],
  },
  { id: "symbols", title: "Symbols", keys: SYMBOLS.map(([id, ch, spoken]) => built(id, ch, ch, spoken)) },
  {
    id: "function", title: "Function",
    keys: Array.from({ length: 12 }, (_, i) => built(`f${i + 1}`, `F${i + 1}`, `f${i + 1}`, `Function ${i + 1}`)),
  },
];
