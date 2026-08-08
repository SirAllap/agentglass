// The ANSI derivation moved to shared/ when the phone grew a terminal.
//
// It had written its own map from palette field to ANSI slot — one to one, with
// no notion of light or dark — and that map put black at 1.24:1 on its own
// background and painted cyan the same hex as blue. The rule that turns a
// theme's four hues into sixteen readable colours is not a per-surface opinion;
// a phone with its own idea of what red means in a terminal is two products
// wearing one name. So it lives beside the palettes both apps are built from.
//
// Re-exported rather than relocated at the call sites, exactly as format.ts does
// with sessionTitle: themes.ts types every pinned `ansi` palette against
// AnsiPalette from this path, and TerminalPanel already asks this path for the
// function. The desktop's own answers are unchanged where they were already
// legible — what moved is the floor under them.
export { deriveAnsi, contrastRatio, type AnsiPalette } from "../../../shared/termPalette.ts";
