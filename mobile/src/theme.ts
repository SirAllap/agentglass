/*
 * What the phone is wearing: a mode, an accent, and the palette they make.
 *
 * Desk / Dark / Light / System, crossed with one of the accents. That is the desk's
 * idea without the desk's catalogue — thirty-seven palettes is a thing you
 * browse at a monitor, not a thing you want in a settings screen in one hand —
 * and the two base palettes ARE two of the desk's: github-dark and github-light,
 * imported from shared/palettes.ts rather than picked again here.
 *
 * ── the computer, and why it is a mode and not a background task ─────────
 * The phone used to wear whatever theme the computer was on, asked on every
 * foreground and repainted from the answer. That could not coexist with a phone
 * that also had its own mode: the machine's answer arrived LAST, so choosing
 * Light on the phone and then pocketing it brought the desk's dark theme back on
 * the way out. So the phone got a mind of its own, and the desk stopped tinting
 * anything but the terminal.
 *
 * "desk" puts the mirror back as one of the choices instead of as a race: it is
 * the default, and Light and Dark are pins that the desk's answer never
 * touches. A desk that has nothing usable to say (never reached, no theme
 * picked, nonsense) leaves the phone following the OS, which is the honest
 * thing for an app with no desk to follow. The answer is remembered, so a cold
 * start wears the last desk it saw while the first request is in flight.
 *
 * ── why this is a mutable module object ───────────────────────────────────
 * On the web this is `:root { --bg: … }` — one global, read at paint time by
 * everything, replaced wholesale on a theme change. React Native has no such
 * thing, and the alternative is threading a palette through every component
 * that needs a border colour, which is most of them.
 *
 * So `C` is that global: read at render time, replaced by `setLook`, with a
 * subscription the root layout uses to re-render the tree.
 *
 * That is also why the system watcher below is `Appearance` and not the
 * `useColorScheme` hook. The hook answers a component; this answers the module
 * every component reads, and one subscription that outlives every screen is
 * what the singleton needs — including on the terminal screen, which must be
 * repainted without being remounted (see TerminalView).
 *
 * ── why the two native modules are required lazily ────────────────────────
 * Because this file is where a palette comes from, and things that are not a
 * phone want one: two suites read `C` to build a terminal document with. A
 * static `import … from "react-native"` at the top of it made `bun test` throw
 * on a Flow type annotation inside react-native's own index.js — in a suite
 * about the composer, which has nothing to do with the theme. Required inside a
 * function they are absent rather than fatal, and the app is unaffected: the
 * only difference off a phone is that there is no OS to ask and nothing to
 * remember, which is exactly right.
 */
import {
  PANE, PHONE_ACCENTS, deskPalette, inkOn, phonePalette, resolveLook, sanitizeLook,
  type AccentId, type Look, type Palette, type Polarity, type ThemeMode,
} from "../../shared/palettes.ts";

export type { AccentId, Look, Palette, Polarity, ThemeMode };
export { PHONE_ACCENTS as ACCENTS };

/*
 * "Match the computer", in teal.
 *
 * Desk is the default for a NEW install: the phone wears the theme the computer
 * is on, and its own system-following look until the computer has answered.
 * Anybody who pinned Light or Dark, or chose an accent, keeps it —
 * `sanitizeLook` reads what was stored and this is only the fallback, so the
 * default never repaints a phone that already made a choice.
 */
const SHIPPED: Look = { mode: "desk", accent: "teal" };

/** The live palette. Read it at render time — never destructure it into a
 *  module-level constant, which would freeze a screen in the palette that was
 *  current when its file was first evaluated. */
export const C: Palette = { ...phonePalette("dark", SHIPPED.accent) };

let look: Look = { ...SHIPPED };
let polarity: Polarity = "dark";
/** What `GET /theme/current` last answered, unvetted: `resolveLook` decides
 *  whether it is a palette. Null is "never heard", which is also what a
 *  computer with no theme picked says. */
let deskVars: unknown = null;
/** `deskVars` as sent, to tell a new answer from the one already painted. */
let deskJson = "null";
/** The computer has answered in this run, so a remembered desk is stale. */
let deskAnswered = false;

const listeners = new Set<() => void>();

/** What is chosen, and what it currently resolves to. `polarity` is the one a
 *  screen wants for anything that is not a colour — a status bar's icons, a
 *  keyboard's appearance — because "system" is not an answer to that. */
export function currentLook(): Look & { polarity: Polarity } {
  return { ...look, polarity };
}

interface AppearanceModule {
  getColorScheme: () => "light" | "dark" | null | undefined;
  addChangeListener: (fn: () => void) => { remove: () => void };
}
interface KeystoreModule {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
}

/*
 * One function per module, each with the module's name written out as a
 * literal, and that is not style: Metro resolves `require` at BUILD time by
 * reading the string, so a shared `native(name)` helper compiles to a require
 * of a module the bundle does not contain and throws on the phone — the one
 * place this has to work. `require` rather than a dynamic import because
 * `systemIsDark` answers while a screen is rendering, and an await would turn
 * a missing module into an unhandled rejection instead of the `null` every
 * caller here already handles.
 */
function appearance(): AppearanceModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("react-native") as { Appearance: AppearanceModule }).Appearance;
  } catch {
    return null; // not a phone: see the header
  }
}

function keystore(): KeystoreModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

function systemIsDark(): boolean {
  // Null is "the OS has not said", which Android reports on a device with no
  // preference set — and it is also every environment that is not a phone.
  // Dark, because that is what this app shipped as and a phone that flashes
  // white on a cold start looks broken.
  return appearance()?.getColorScheme() !== "light";
}

/**
 * Paint. Every key is copied rather than the object replaced, because `C` is
 * imported by identity all over the app: reassigning the binding would leave
 * every existing import pointing at the old object.
 */
function paint(): void {
  const resolved = resolveLook(look, systemIsDark(), deskVars);
  polarity = resolved.polarity;
  const next = resolved.palette;
  let changed = false;
  for (const key of Object.keys(PANE.dark) as (keyof Palette)[]) {
    if (C[key] !== next[key]) { C[key] = next[key]; changed = true; }
  }
  if (!changed) return; // a system event that resolved to the same surface
  for (const fn of listeners) fn();
}

/** The desk's palette as the Look picker previews it, or null when there is
 *  none to show (phone mode). Computed for the chosen accent. */
export function deskPreview(): Palette | null {
  return deskPalette(deskVars, look.accent)?.palette ?? null;
}

export function onPaletteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const KEY = "agentglass.look";
const DESK_KEY = "agentglass.desk";

/**
 * The computer's theme, as it answered. Applies immediately and is remembered
 * for the next cold start, so a phone on "Match the computer" opens in the
 * desk's colours instead of in the phone's for the second the first request
 * takes. The answer is only ever painted when the look is "desk".
 */
export function setDeskTheme(vars: unknown): void {
  deskAnswered = true; // a stored desk read late must not overrule this, even an unchanged null
  const next = JSON.stringify(vars ?? null);
  if (next === deskJson) return; // the same answer on every foreground is the usual one
  deskJson = next;
  deskVars = vars ?? null;
  void keystore()?.setItemAsync(DESK_KEY, next).catch(() => {});
  paint();
  // The terminal paints the desk's own colours whatever the look is, so a pin
  // that left the app's palette unchanged must still reach it.
  for (const fn of listeners) fn();
}

/** The computer's raw theme vars, for the one surface that is a window onto
 *  the computer's screen (the terminal). Null when it has not said. */
export function deskThemeVars(): Partial<Palette> | null {
  return deskVars && typeof deskVars === "object" ? deskVars as Partial<Palette> : null;
}

/** Choose. Applies immediately and remembers in the background — a theme that
 *  waits on a keystore write to repaint is a theme that feels broken. */
export function setLook(next: Partial<Look>): void {
  look = {
    mode: next.mode ?? look.mode,
    accent: next.accent ?? look.accent,
  };
  paint();
  void keystore()?.setItemAsync(KEY, JSON.stringify(look))
    .catch(() => {
      // A keystore that will not write leaves the choice live for this run. The
      // alternative — refusing the change — would be a settings screen that does
      // nothing for a reason nobody on a phone can act on.
    });
}

/*
 * Read the remembered choice, once, at startup.
 *
 * Fired at module scope rather than from a hook: `C` is read by the first frame
 * of every screen, so the read has to be in flight before any of them mounts.
 * The app shows its splash until the host has been read out of the same
 * keystore, which is the same order of milliseconds — but if this does land
 * late, it lands as a repaint of a dark app into the chosen one, never as a
 * screen that stays wrong.
 */
void (async (): Promise<void> => {
  // Independent reads, and this is the first-paint window: one round trip.
  const [look_, desk_] = await Promise.all([
    keystore()?.getItemAsync(KEY).catch(() => null),
    keystore()?.getItemAsync(DESK_KEY).catch(() => null),
  ]);
  try {
    // Field by field and never trusted — see sanitizeLook. An accent id that no
    // longer exists would paint the app a colour its own picker cannot select.
    if (look_) look = sanitizeLook(JSON.parse(look_), look);
  } catch {
    // Unreadable or hand-edited into nonsense. The shipped look stands.
  }
  try {
    // A fresh answer that landed first is newer than the one on disk.
    if (desk_ && !deskAnswered) { deskVars = JSON.parse(desk_); deskJson = desk_; }
  } catch {
    // No remembered desk: the phone's own look until the computer answers.
  }
  paint();
})();

/*
 * The OS flipping light/dark, which only matters in System — and in "desk",
 * for as long as the computer has no theme to follow (paint ignores the OS
 * once it does).
 *
 * Subscribed once, for the life of the process, and never removed: the thing it
 * updates is a module singleton, so there is no component whose unmount should
 * stop it. Android delivers this whether the app is foreground or not.
 */
appearance()?.addChangeListener(() => { if (look.mode === "system" || look.mode === "desk") paint(); });

/** Ink for text sitting ON a coloured face — a button, the send key, a badge.
 *  See shared/palettes.ts: the face is the accent now, and near-black on the
 *  neutral accent of a light screen is near-black on near-black. */
export const ink = inkOn;

/**
 * What a queue card's tone paints, resolved at call time.
 *
 * A function rather than a table, because a table built at module scope holds
 * the colours the palette had when this file was first imported — which is
 * before the remembered look has been read, every single time.
 *
 * `crit` is a person blocked on you and nothing else gets that colour, which is
 * why the scale is not "red for anything bad".
 */
export function toneColor(tone: "crit" | "bad" | "good" | "plain"): string {
  return tone === "crit" ? C.error : tone === "bad" ? C.warning : tone === "good" ? C.success : C.text4;
}

/**
 * Type sizes, in one place because a phone punishes drift more than a desk.
 *
 * The floor is 12: the dashboard runs at 11.5px and gets away with it at
 * arm's length on a 27-inch monitor. Outdoors, in one hand, it does not.
 */
export const T = {
  /* Pane's ladder asks for 10.5 here and it does not get it. The rule above is
     older and it wins: this is read outdoors, in one hand, by somebody deciding
     whether a check failed. What makes an eyebrow an eyebrow is the tracking
     and the caps, and Label already carries both — see ui.tsx. */
  eyebrow: 11,
  small: 12,
  body: 14,
  title: 17,
  head: 20,
  /* One line per screen, and only the line that says what the screen is FOR:
     "3 things want you". It is not a title — a title names a thing and this
     states a count, which is why the only place it appears is the top of Now.
     A PR's own title is prose and stays at `head`, because 26pt of somebody
     else's sentence is four lines before the screen has said anything. */
  display: 26,
} as const;

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/*
 * Corners, and the ladder is deliberately not even.
 *
 * `sm` and `md` sit two points apart on purpose. Small furniture — a key, a
 * chip, a badge — is nearly a rectangle with the corner taken off, and a
 * control is barely rounder. That is the whole of the shape language for
 * everything you press: flat, quiet, and not competing with the words in it.
 * A phone screen at 393 points is mostly small furniture, and a ladder that
 * separates each rung visibly ends up with eight different corners on one
 * screen, which reads as several apps stacked.
 *
 * Then there is exactly ONE round thing, and `pill` is it: a capsule, for the
 * one surface per screen that is a place to type or a single filter. Being far
 * away from the rest is the point — one round shape among rectangles is a
 * signal, and three sizes of round is decoration.
 *
 * `lg` is the middle: cards, sheets and grouped rows. It went 14 → 16 when `sm`
 * went 6 → 8, because it is the container those small things sit inside and a
 * container whose corner is tighter than its contents' looks like a mistake.
 */
export const RADIUS = { sm: 8, md: 10, lg: 16, pill: 22 } as const;

/**
 * A palette colour at low opacity, as a wash behind text.
 *
 * Eight-digit hex rather than `rgba(…)` with the channels written out, because
 * the channels are the point: a literal freezes whichever palette was current
 * when somebody typed it, and the two places this is used — the diff's added
 * and removed rows — carried github-dark's green and red long after the phone
 * stopped wearing github-dark. The red had drifted a whole hue away from the
 * `C.error` printed on the same row.
 *
 * Call it at render time. A tint hoisted to module scope is the same bug in a
 * new place: it would hold the shipped palette through every theme change.
 */
export function tint(hex: string, alpha: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${pct.toString(16).padStart(2, "0")}`;
}

/**
 * The veil behind a sheet.
 *
 * A constant and not a palette entry, because a scrim's job is to darken what
 * is behind it and that job does not change in Light — a pale veil over a pale
 * page is a sheet with no edge. It is PANE's own ground at 55%, so the dark
 * mode's dimmed background is the colour the app is already made of.
 *
 * One constant because there were two: a sheet dimmed to `rgba(1,4,9,.55)` and
 * a modal on another screen to `rgba(0,0,0,.55)`, which are visibly different
 * greys on the same phone thirty seconds apart.
 */
export const SCRIM = "rgba(10,12,16,0.55)";

/** A monospace face that exists on Android, for a command or a branch name. */
export const MONO = "monospace";
