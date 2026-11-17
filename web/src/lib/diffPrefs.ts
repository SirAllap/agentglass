/*
 * How a diff opens, before anybody touches the toggles.
 *
 * Three panels show diffs — file changes, source control, pull requests — and
 * all three opened side-by-side with no wrapping (now Unified by default; Split is opt-in), hardcoded, in three separate
 * `useState` calls. That is a defensible default and it is not everyone's: a
 * 13" screen has no room for two columns, and long prose lines in a markdown
 * diff are unreadable without wrapping.
 *
 * These are DEFAULTS, not the live state. The toggle in each panel still wins
 * for as long as you are looking at that diff — changing your mind about one
 * file is not a preference, and a control that quietly rewrote your settings
 * every time you pressed it would be a control nobody could use for a glance.
 */

import { THEME_KEY } from "./diffHighlight.ts";

const SPLIT_KEY = "agentglass.diff.split";
const WRAP_KEY = "agentglass.diff.wrap";
const NOWS_KEY = "agentglass.diff.noWhitespace";

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, on: boolean, dflt: boolean) => {
  // The default is stored as an absent key, so a machine that never chose
  // follows the default if it ever moves.
  try { if (on === dflt) localStorage.removeItem(k); else localStorage.setItem(k, on ? "1" : "0"); }
  catch { /* private mode */ }
};

/** One column: Split needs room two columns of code do not have in a side panel, so it is opt-in. */
export const DEFAULT_SPLIT = false;
/** Off, as it has always been: a wrapped diff loses the column alignment that
 *  makes a change scannable, so it is worth asking for rather than assuming. */
export const DEFAULT_WRAP = false;

/** On, because a whitespace-only change is a real change and a reader who has not
 *  asked to hide one should not have it hidden. */
export const DEFAULT_NO_WHITESPACE = false;

export const diffSplit = (): boolean => (read(SPLIT_KEY) === null ? DEFAULT_SPLIT : read(SPLIT_KEY) === "1");
export const diffNoWhitespace = (): boolean => (read(NOWS_KEY) === null ? DEFAULT_NO_WHITESPACE : read(NOWS_KEY) === "1");
export const diffWrap = (): boolean => (read(WRAP_KEY) === null ? DEFAULT_WRAP : read(WRAP_KEY) === "1");

export function setDiffSplit(on: boolean): void { write(SPLIT_KEY, on, DEFAULT_SPLIT); }
export function setDiffWrap(on: boolean): void { write(WRAP_KEY, on, DEFAULT_WRAP); }
export function setDiffNoWhitespace(on: boolean): void { write(NOWS_KEY, on, DEFAULT_NO_WHITESPACE); }

/** The syntax theme every diff view reads at mount; "auto" follows light/dark.
 *  Same key the diff views persist, so Settings and a diff toolbar are one store. */
export const diffThemePref = (): string => read(THEME_KEY) || "auto";
export const setDiffThemePref = (v: string): void => { try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode */ } };

/** The Diff page's own list choices, stored under the keys DiffPage reads at mount (agentglass.diff.v3.*). */
const GROUP_KEY = "agentglass.diff.v3.groupBy";
const IGNORED_KEY = "agentglass.diff.v3.showIgnored";
const OUTSIDE_KEY = "agentglass.diff.v3.showOutside";
export type DiffGroupBy = "worktree" | "time" | "folder";
export const DEFAULT_GROUP_BY: DiffGroupBy = "worktree";
export const diffGroupBy = (): DiffGroupBy => { const r = read(GROUP_KEY); return r === "time" || r === "folder" ? r : DEFAULT_GROUP_BY; };
export const setDiffGroupBy = (v: DiffGroupBy): void => { try { localStorage.setItem(GROUP_KEY, v); } catch { /* private mode */ } };
export const diffShowIgnored = (): boolean => read(IGNORED_KEY) === "1";
export const setDiffShowIgnored = (on: boolean): void => { try { localStorage.setItem(IGNORED_KEY, on ? "1" : "0"); } catch { /* private mode */ } };
export const diffShowOutside = (): boolean => read(OUTSIDE_KEY) === "1";
export const setDiffShowOutside = (on: boolean): void => { try { localStorage.setItem(OUTSIDE_KEY, on ? "1" : "0"); } catch { /* private mode */ } };
