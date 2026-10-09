/*
 * Making a palette change visible to React.
 *
 * `C` is a mutable module object (see theme.ts) — React has no idea it moved,
 * so a component subscribes and bumps a counter, and its subtree re-renders
 * reading the new values.
 *
 * ── why every screen calls this, and not just the root ────────────────────
 * Because the root's subscription only repaints the root. Measured on the
 * emulator with the first version, which had exactly one call in the layout:
 * tapping Light repainted the ONE CARD that was subscribed — the picker itself
 * — and left the header, the tab bar, the other cards and every other screen in
 * the dark palette. react-navigation holds a mounted scene as an element it
 * already has, so re-rendering the tree above it changes nothing below it.
 *
 * The obvious fix is the wrong one: a `key` on the navigator does repaint
 * everything, by remounting it. That would take the terminal's WebView down
 * with it — a socket dropped and a tmux pane re-attached in front of somebody,
 * because they chose a colour. So each screen asks for itself; a screen that
 * has not been opened yet renders in the current palette anyway.
 *
 * The pairing screen is the one that does not call it, and cannot need to:
 * Settings is unreachable until this phone is paired.
 *
 * ── the computer's own palette ────────────────────────────────────────────
 * "Match the computer" is the default look, so `useDeskTheme` (mounted once by
 * the root) keeps the theme module in step with `/theme/current`, and the whole
 * app wears it; a Light or Dark pin ignores the answer.
 *
 * The terminal wants the answer under every look, and raw, because that screen
 * is not chrome, it is a WINDOW ONTO THE COMPUTER'S SCREEN, and the computer
 * paints it. Measured on a real pane: agentglass's own theme sync writes
 * `set -g window-style "bg=<the desk's --bg>"` into the user's tmux
 * (server/src/themesync.ts), so every cell of every pane arrives with an
 * explicit background and the phone's `theme.background` is never reached. With
 * the phone in Light against that dark tmux, the DEFAULT foreground went to
 * #1f2328 and the words "Claude Code" at the top of a session disappeared into
 * the pane — dark on dark, while everything the program had coloured itself
 * stayed readable. `useDeskPalette` reads what the root already fetched.
 */
import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { deskThemeVars, onPaletteChange, setDeskTheme, type Palette } from "../theme.ts";

export function usePaletteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onPaletteChange(() => setTick((n) => n + 1)), []);
  return tick;
}

interface ThemeAnswer {
  theme: { name: string; vars: Partial<Palette> } | null;
}

/**
 * The palette the computer is wearing, for the one surface it paints.
 *
 * Null means the machine has never had a theme picked (it answers `theme: null`
 * rather than guessing) or has not been reached yet, and the caller falls back
 * to the phone's own palette. That is kept as null rather than turned into a
 * default here: "not configured" and "configured to the default" are different
 * facts, and only the caller knows what to do with the difference.
 */
export function useDeskPalette(): Partial<Palette> | null {
  usePaletteTick();
  return deskThemeVars();
}

/**
 * Keep the app's own palette in step with the computer's, for "Match the
 * computer". Mounted once by the root, because the choice colours every screen;
 * the answer is handed to the theme module, which paints it only when the look
 * is "desk" — so this can run under a pin without being able to overrule it.
 *
 * `theme: null` is passed on as null: a computer that has no theme picked must
 * clear the last one it had, or the phone would keep a desk the user has since
 * left behind.
 */
export function useDeskTheme(host: Host | null): void {
  useEffect(() => {
    if (!host) return;
    let alive = true;
    const pull = async (): Promise<void> => {
      const answer = await ask<ThemeAnswer>(host, "/theme/current");
      if (!alive || !answer.ok) return; // offline keeps the colours it has
      setDeskTheme(answer.value.theme?.vars ?? null);
    };
    void pull();
    const onChange = (state: AppStateStatus): void => { if (state === "active") void pull(); };
    const sub = AppState.addEventListener("change", onChange);
    return () => { alive = false; sub.remove(); };
  }, [host]);
}
