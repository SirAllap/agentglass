// What the Appearance page holds, as plain data: sections in order, each row's
// label, its one-sentence help and the setting id it writes (if it has one).
// The page renders from this, and the tests read it, so the copy rule and
// "each row once" are checked on the same list the person sees.
import type { SectionKind } from "../shell/shellRules.ts";

export interface AppearanceRowDef {
  label: string;
  /** One sentence, 14 words at most, ends with a full stop. */
  help: string;
  /** The setting id it writes. Window rows keep their own stores and have none. */
  id?: string;
}

export interface AppearanceSectionDef {
  id: string;
  title: string;
  kind: SectionKind;
  rows: AppearanceRowDef[];
}

export const APPEARANCE_PURPOSE = "Choose how agentglass looks and how it starts.";

export const APPEARANCE_SECTIONS: AppearanceSectionDef[] = [
  { id: "look", title: "Look", kind: "normal", rows: [
    { label: "Density", help: "How much air rows and cards get.", id: "appearance.density" },
    { label: "Interface font size", help: "Terminals have their own size.", id: "appearance.fontSize" },
    { label: "Reduce motion", help: "Skips sliding and fade animations.", id: "appearance.reduceMotion" },
    { label: "Translucent window", help: "Lets your desktop show through the window.", id: "appearance.translucent" },
  ] },
  { id: "theme", title: "Theme", kind: "normal", rows: [
    { label: "Mode", help: "Dark, light, or follow your system.", id: "appearance.mode" },
    { label: "Palette", help: "The set of colors the whole app wears.", id: "appearance.theme" },
    { label: "Accent color", help: "Colors buttons and highlights.", id: "appearance.accent" },
  ] },
  { id: "window", title: "Window", kind: "normal", rows: [
    { label: "Clock", help: "12 or 24 hours, in fullscreen." },
    { label: "Fullscreen", help: "Hides the window frame; F11 works anywhere." },
    { label: "Launch animation", help: "Plays a cover while the app wakes up." },
    { label: "Start at login", help: "Opens agentglass when you log in." },
    { label: "Display size", help: "Scales everything inside the window." },
  ] },
  { id: "sidebar", title: "Sidebar", kind: "normal", rows: [
    { label: "View", help: "Pick a view, then choose how the sidebar shows it." },
    { label: "Shown on the rail", help: "Choose whether this view is listed on the rail.", id: "rail.place.*" },
    { label: "Sits at", help: "Top is where you work; bottom is what you look at.", id: "rail.place.*" },
    { label: "Order", help: "Moves this view up or down within its place on the rail." },
    { label: "Count badge", help: "Shows how many things need you.", id: "rail.badge.*" },
    { label: "Shortcut", help: "The key that opens this view lives on Shortcuts." },
  ] },
];
