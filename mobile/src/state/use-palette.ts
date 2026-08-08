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
 * ── the computer's own palette, which is a different question ─────────────
 * `usePaletteFrom(host)` used to paint the WHOLE APP in whatever theme the
 * computer was on. That cannot coexist with a phone that has its own mode —
 * the machine's answer landed last, so a phone set to Light came back out of a
 * pocket in the desk's dark theme — so the app's chrome is the phone's now.
 *
 * The terminal is the exception, and `useDeskPalette` below is why it survived:
 * that screen is not chrome, it is a WINDOW ONTO THE COMPUTER'S SCREEN, and the
 * computer paints it. Measured on a real pane: agentglass's own theme sync
 * writes `set -g window-style "bg=<the desk's --bg>"` into the user's tmux
 * (server/src/themesync.ts), so every cell of every pane arrives with an
 * explicit background and the phone's `theme.background` is never reached. With
 * the phone in Light against that dark tmux, the DEFAULT foreground went to
 * #1f2328 and the words "Claude Code" at the top of a session disappeared into
 * the pane — dark on dark, while everything the program had coloured itself
 * stayed readable.
 */
import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { onPaletteChange, type Palette } from "../theme.ts";

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
 * Asked once per host and again on every foreground, which is when somebody has
 * most likely just changed the theme at their desk.
 *
 * Null means the machine has never had a theme picked (it answers `theme: null`
 * rather than guessing) or has not been reached yet, and the caller falls back
 * to the phone's own palette. That is kept as null rather than turned into a
 * default here: "not configured" and "configured to the default" are different
 * facts, and only the caller knows what to do with the difference.
 */
export function useDeskPalette(host: Host | null): Partial<Palette> | null {
  const [desk, setDesk] = useState<Partial<Palette> | null>(null);

  useEffect(() => {
    if (!host) { setDesk(null); return; }
    let alive = true;
    const pull = async (): Promise<void> => {
      const answer = await ask<ThemeAnswer>(host, "/theme/current");
      if (!alive || !answer.ok) return; // offline keeps the colours it has
      setDesk(answer.value.theme?.vars ?? null);
    };
    void pull();
    const onChange = (state: AppStateStatus): void => { if (state === "active") void pull(); };
    const sub = AppState.addEventListener("change", onChange);
    return () => { alive = false; sub.remove(); };
  }, [host]);

  return desk;
}
