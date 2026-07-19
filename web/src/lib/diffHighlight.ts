// Shared Shiki wiring for every diff surface (the telemetry ChangesModal and the
// live git panel). One hook owns the highlighter, on-demand language + theme
// loading, and the persisted theme/bold preferences, and returns the `Hilite`
// value to drop into <HiliteCtx.Provider>.
import { createContext, useEffect, useMemo, useState } from "react";
import type { Highlighter } from "shiki";
import { getHighlighter, langFromPath, shikiTheme, ensureTheme, themeLabel } from "./highlight.ts";

export type Hilite = { hl: Highlighter | null; lang: string | null; theme: string | null };
export const HiliteCtx = createContext<Hilite>({ hl: null, lang: null, theme: null });

export const THEME_KEY = "agentglass.diffTheme";
export const BOLD_KEY = "agentglass.diffBold";

export function useDiffHighlight(filePath?: string) {
  const [hl, setHl] = useState<Highlighter | null>(null);
  const [loadedLangs, setLoadedLangs] = useState<Set<string>>(() => new Set());
  const [themePref, setThemePref] = useState<string>(() => { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch { return "auto"; } });
  const [bold, setBold] = useState<boolean>(() => { try { return localStorage.getItem(BOLD_KEY) !== "0"; } catch { return true; } });
  const [themeName, setThemeName] = useState<string | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [langError, setLangError] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const lang = useMemo(() => langFromPath(filePath), [filePath]);

  // Every stage below fetches a chunk at runtime, so every stage can fail for
  // reasons the user cannot see — and each one fails into the *same* blank
  // monochrome diff. Swallowing any of them is what made this bug take three
  // separate reports to pin down, so all three now surface on the picker.
  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => { if (alive) { setHl(h); setCoreError(null); } })
      .catch(() => { if (alive) setCoreError("Syntax highlighting couldn't start — the highlighter failed to load."); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!hl || !lang || loadedLangs.has(lang)) return;
    let alive = true;
    hl.loadLanguage(lang as never)
      .then(() => { if (alive) { setLoadedLangs((s) => new Set(s).add(lang)); setLangError(null); } })
      .catch(() => { if (alive) setLangError(`The ${lang} grammar couldn't be loaded — this file is shown as plain text.`); });
    return () => { alive = false; };
  }, [hl, lang, loadedLangs]);
  // Resolve "auto" to the app's light/dark, then register the chosen theme
  // (boldified when `bold`) and keep the previous one until the new one is ready.
  // Memoized so we don't run getComputedStyle on every render (e.g. every
  // keystroke in a filter box that shares this component tree).
  const resolvedTheme = useMemo(() => (themePref === "auto" ? shikiTheme() : themePref), [themePref]);
  useEffect(() => { try { localStorage.setItem(THEME_KEY, themePref); } catch { /* ignore */ } }, [themePref]);
  useEffect(() => { try { localStorage.setItem(BOLD_KEY, bold ? "1" : "0"); } catch { /* ignore */ } }, [bold]);
  useEffect(() => {
    if (!hl) return;
    let alive = true;
    // A theme that won't load is reported rather than swallowed: without this
    // the diff just renders monochrome and the picker keeps claiming the theme
    // the user chose is the one on screen.
    ensureTheme(hl, resolvedTheme, bold).then(({ name, failed }) => {
      if (!alive) return;
      setThemeName(name);
      setThemeError(!failed ? null
        : `${themeLabel(failed)} couldn't be loaded — ${name ? `showing ${themeLabel(name)} instead` : "syntax highlighting is off"}.`);
    }).catch(() => { if (alive) setThemeError("The syntax theme couldn't be loaded."); });
    return () => { alive = false; };
  }, [hl, resolvedTheme, bold]);

  // Stable context object so <HiliteCtx.Provider> doesn't re-render every
  // memoized <Code> whenever an unrelated parent state changes.
  const hilite = useMemo<Hilite>(() => ({ hl, lang: lang && loadedLangs.has(lang) ? lang : null, theme: themeName }), [hl, lang, loadedLangs, themeName]);
  // Reported worst-first: a highlighter that never started explains the theme
  // and grammar being missing too, so leading with those would misdirect.
  const hiliteError = coreError ?? themeError ?? langError;
  return { hilite, themePref, setThemePref, bold, setBold, hiliteError };
}
