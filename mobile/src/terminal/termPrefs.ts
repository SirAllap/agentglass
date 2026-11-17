/*
 * What this phone remembers about how it draws a terminal.
 *
 * A module singleton with a subscription, which is the shape theme.ts already
 * uses and for the same reasons: the value is read by a screen's first frame,
 * it is written from a different screen, and both have to see the same thing
 * without either one owning it.
 *
 * ── the keystore, again, for something that is not a secret ──────────────
 * `expo-secure-store` is what this app has — the paired credential, the theme
 * and the seen-map all live there. A second storage library for one small
 * object would be a dependency, a build question on three platforms, and
 * another thing that can fail on a cold start. Its size limit does not bind
 * here: this is at most seventeen short ids.
 *
 * ── every failure is the default ─────────────────────────────────────────
 * A read that fails, a value from an older build, a write that is refused: all
 * of them end at the catalogue's own order with nothing hidden, which is a key
 * bar that works. The opposite failure — refusing to draw a bar because a
 * preference could not be read — is a terminal you cannot type Escape into.
 */
import { DEFAULT_LAYOUT, parse, serialise, type KeyLayout } from "./keyLayout.ts";
import { parseCustom, type CustomKey } from "./customKeys.ts";

const KEY = "agentglass.term.v1";

/**
 * How many columns the phone asks the pane for.
 *
 * Orca calls the same setting a text size and scales the type; this app has
 * always expressed it as columns, and the two are the same dial read from
 * opposite ends — fewer columns is bigger text. Columns is the honest unit
 * here because it is what actually goes down the socket, and because the note
 * this screen already draws when a pane is wider than the phone is counted in
 * them.
 *
 * TWO rungs, and the reason is measured rather than conservative. The note over
 * `columns` in app/(tabs)/terminal.tsx has the numbers: at this phone's 412
 * CSS px, 50 columns is an 8.2px cell and 80 is 5.15px, but 120 is 3.43px —
 * above the font floor, so nothing overlaps and a screenshot merely looks like
 * small text. It is not small text. At that size the glyph is clipped inside
 * its own cell and characters change identity: `#472` read back as `#4/2` and
 * `faf0e9d` as `tat0e9d`, a seven without its bar being a slash. A width
 * control that misreports the commit somebody is looking at is worse than one
 * that does not offer the rung, and 100 is not offered either because nobody
 * has measured it.
 *
 * Stored because it is a property of the PHONE — its screen, and whose eyes
 * are on it — rather than of any pane, so re-choosing it on every attach was
 * work nobody should have to repeat.
 */
export const COLUMNS = [50, 80] as const;
/**
 * The column count the drawing's 12.5 pt comes out as on a 390-wide phone,
 * which is the frame it was drawn in. 80 columns was 8.3 pt and, measured on
 * the emulator, glyphs clipped inside their own cells.
 */
export const DEFAULT_COLUMNS = 50;
/** The band a column count may come from. Wider than COLUMNS because the text
 *  size below asks for counts the two rungs do not offer, and a stored 57 is a
 *  working pane rather than a value to refuse. */
export const MIN_COLUMNS = 20;
export const MAX_COLUMNS = 400;

/**
 * The text sizes the ⋯ sheet steps through, in points.
 *
 * The same five the mock draws, and all of them bigger than this app has ever
 * had: 60 columns on a 412px phone is about 11.4pt, so the small end of this
 * scale starts where the width control's big end already was, and the scale
 * exists for reading a pane from a distance rather than for seeing all of it.
 *
 * Still one dial, read from the other end. Columns are what goes down the
 * socket, so a size here is turned into the column count that fits at it (see
 * columnsForText) and nothing else is stored: two stored numbers that both
 * decide a width is two values that can disagree.
 */
export const TEXT_STEPS = [11.5, 12.5, 14, 15.5, 17] as const;

/** How wide a cell is as a fraction of its point size.
 *
 *  0.6 is what the page's own probe falls back to, and what this app measured
 *  on Android: 60 columns on a 412px screen is a 6.85px cell at 11.4pt. */
export const CELL_RATIO = 0.6;

/** The room the page's grid does not have: `#screen { inset: 0 8px }` in
 *  terminal-html.ts, both sides, because a phone's last glyph was ending on the
 *  bezel. Columns are counted inside it, so a width that ignores it asks for
 *  one column too many. */
const GUTTER = 16;

const clampColumns = (n: unknown): number =>
  typeof n === "number" && Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS
    ? n
    : DEFAULT_COLUMNS;

/** How many columns fit across a screen of this width at this size. */
export function columnsForText(width: number, size: number): number {
  const usable = Math.max(0, width - GUTTER);
  const cols = Math.round(usable / (Math.max(4, size) * CELL_RATIO));
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, cols));
}

/** The size those columns actually came out at, in points, one decimal.
 *
 *  Not the step that was asked for: a column count is whole, so asking for 17pt
 *  on a 412px phone lands on 39 columns, which is 16.9pt. Reporting the size the
 *  pane really got is the difference between a control and a decoration. */
export function textSizeFor(columns: number, width: number): number {
  const usable = Math.max(0, width - GUTTER);
  const pt = usable / Math.max(1, columns) / CELL_RATIO;
  return Math.round(pt * 10) / 10;
}

/** The column count one step up or down the scale, or the same count at an end
 *  of it — never past 11.5 or 17.
 *
 *  A step moves at least one column. Two adjacent sizes often round to the same
 *  count (15.35pt and 15.5pt are both 43 columns on a 412px phone), and a `+`
 *  that returned 43 for 43 is a button that does nothing for one press in five. */
export function stepColumns(columns: number, width: number, dir: 1 | -1): number {
  const now = textSizeFor(columns, width);
  const top = TEXT_STEPS[TEXT_STEPS.length - 1]!;
  const bottom = TEXT_STEPS[0]!;
  // At an end of the scale, the press changes nothing — a size control that
  // walks past 17 is one that lies about what it offers.
  if (dir > 0 ? now >= top - 0.1 : now <= bottom + 0.1) return columns;
  // 0.1 of tolerance: a column count is a whole number, so a size can sit a
  // hundredth from a step it is already on, and stepping "to" it again would be
  // a press that does nothing.
  const order = dir > 0 ? [...TEXT_STEPS] : [...TEXT_STEPS].reverse();
  const next = order.find((s) => (dir > 0 ? s > now + 0.1 : s < now - 0.1)) ?? (dir > 0 ? top : bottom);
  const want = columnsForText(width, next);
  // Two adjacent steps can round to the same count; then the press moves one
  // column in its direction rather than not at all.
  return want === columns ? (dir > 0 ? columns - 1 : columns + 1) : want;
}

/** "12.5 pt · 53 characters across", the sheet's one line. */
export function textLabel(columns: number, width: number): string {
  return `${textSizeFor(columns, width).toFixed(1)} pt · ${columns} characters across`;
}

/**
 * Whether the phone's keyboard may help while composing a line.
 *
 * OFF, and that is the default rather than a preference with no opinion. The
 * field composes a command: a keyboard that autocorrects rewrites flags, paths
 * and branch names into English words, and it does it silently — `--no-verify`
 * becomes `--no verify`, `src/ui.tsx` gains a capital, and the first anybody
 * knows is a command that did not run or, worse, one that ran differently.
 *
 * It is offered at all because the same field is also where somebody types a
 * sentence to an agent, and there the help is help. So it is a choice, made
 * once, defaulting to the side where being wrong is cheap.
 *
 * Direct keys are unaffected either way: in `keys` mode a keystroke goes to
 * the pane without passing through a composer, so there is nothing for a
 * suggestion to act on.
 */
export const CURSORS = ["block", "bar", "underline"] as const;
export type CursorShape = typeof CURSORS[number];
export const parseCursor = (v: unknown): CursorShape => (CURSORS as readonly unknown[]).includes(v) ? (v as CursorShape) : "block";

interface Prefs {
  layout: KeyLayout;
  columns: number;
  assist: boolean;
  /** How the pane's cursor is drawn. */
  cursor: CursorShape;
  /** Keys somebody added. See customKeys.ts for the rules; this only stores
   *  them, and reads them back through the same parser so a value written by
   *  an older build cannot reach the bar malformed. */
  custom: CustomKey[];
}

/** The one module read here, required lazily and by a literal name.
 *
 *  Metro resolves `require` at BUILD time by reading the string, so a shared
 *  helper taking a module name compiles to a require of something the bundle
 *  does not contain — the argument is set out at length in theme.ts. This file
 *  is also imported by `bun test`, where there is no phone and no keystore,
 *  and the `null` is what makes that work rather than throw. */
export interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

/** Exported for keepAlive.ts, which wants the exact same lazy, literal
 *  `require("expo-secure-store")` and has no reason to carry a second copy of
 *  it — see the comment above for why the require has to look like this. */
export function keystore(): KeystoreModule | null {
  try {
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

let prefs: Prefs = { layout: DEFAULT_LAYOUT, columns: DEFAULT_COLUMNS, assist: false, cursor: "block", custom: [] };
const listeners = new Set<() => void>();

export const keyLayout = (): KeyLayout => prefs.layout;
export const termColumns = (): number => prefs.columns;
export const termAssist = (): boolean => prefs.assist;
export const termCursor = (): CursorShape => prefs.cursor;
export const customKeys = (): CustomKey[] => prefs.custom;

/** Told, rather than polled. The terminal and the settings screen are both on
 *  screen at different times and neither owns the value. */
export function onTermPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setKeyLayout(next: KeyLayout): void {
  save({ ...prefs, layout: next });
}

/** Clamped to the offered set rather than trusted: this ends up in a
 *  `resize-window` on somebody's machine, and a number from a stored value is
 *  a number from an older build. */
export function setTermColumns(next: number): void {
  const want = COLUMNS.includes(next as typeof COLUMNS[number]) ? next : DEFAULT_COLUMNS;
  save({ ...prefs, columns: want });
}

/**
 * A column count this phone computed from a text size, kept as it came.
 *
 * `setTermColumns` above is the two-rung width control and refuses anything
 * else, which is right for that control and wrong for this one: 12.5pt is 53
 * columns, and clamping it back to 80 would make the size stepper a button that
 * undoes itself. The band is still enforced, because this number ends up in the
 * same `resize-window`. */
export function setTermTextColumns(next: number): void {
  save({ ...prefs, columns: clampColumns(next) });
}

export function setTermAssist(on: boolean): void {
  save({ ...prefs, assist: on });
}

export function setTermCursor(next: CursorShape): void {
  save({ ...prefs, cursor: parseCursor(next) });
}

export function setCustomKeys(next: CustomKey[]): void {
  save({ ...prefs, custom: next });
}

function save(next: Prefs): void {
  prefs = next;
  for (const fn of [...listeners]) fn();
  void keystore()?.setItemAsync(KEY, JSON.stringify({
    layout: JSON.parse(serialise(next.layout)) as unknown,
    columns: next.columns,
    assist: next.assist,
    cursor: next.cursor,
    custom: next.custom,
  }))
    .catch(() => {
      // The choice stays live for this run. Refusing the change instead would
      // be a settings screen that does nothing, for a reason nobody holding a
      // phone can act on.
    });
}

/*
 * Read once, at startup.
 *
 * At module scope rather than from a hook, for the reason theme.ts gives about
 * `C`: the terminal's first frame draws this bar, so the read has to be in
 * flight before that screen mounts. Landing late is handled — the listeners
 * fire and the bar redraws — which is why this is not awaited anywhere.
 */
void (async () => {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as {
      layout?: unknown; columns?: unknown; assist?: unknown; cursor?: unknown; custom?: unknown;
    };
    const layout = parse(stored.layout ? JSON.stringify(stored.layout) : null);
    const columns = clampColumns(stored.columns);
    prefs = { layout, columns, assist: stored.assist === true, cursor: parseCursor(stored.cursor), custom: parseCustom(stored.custom) };
    for (const fn of [...listeners]) fn();
  } catch {
    // Left at the default, which is a working bar.
  }
})();
