/*
 * What the Terminal strip shows, left to right, as data.
 *
 * A project is a space: the chip names the one you are in and the tabs after it
 * are its windows. Projects you keep open follow, each behind a small label, in
 * the order the groups sit in tmux. The rest are one click away in the Go list.
 * Alt and the prefix reveal a number on the first nine tabs of what is on
 * screen; a window folded out of the strip has none, so the key cannot point at
 * something you cannot see.
 *
 * Groups come from `buildGroups`. When tab groups are switched off the caller
 * has no project to name and draws its windows flat itself.
 */
import type { TmuxWindow } from "../../../shared/types.ts";
import type { TabGroup } from "./tabGroups.ts";

export interface StripInput {
  groups: readonly TabGroup[];
  /** The key of the project you are in. Unknown or null falls back to the first
   *  group, so the strip is never empty while windows exist. */
  current: string | null;
  /** Keys of the projects kept open in the strip. */
  kept: ReadonlySet<string>;
  /** The tmux session is locked. */
  locked?: boolean;
}

export type StripItem =
  | { kind: "label"; key: string; name: string }
  | { kind: "tab"; window: TmuxWindow; project: string; number: number | null };

export interface StripZones {
  chip: { key: string; name: string; count: number; locked: boolean } | null;
  items: StripItem[];
  /** One project in all: no labels, nothing to keep open. */
  flat: boolean;
  /** Window id to its Alt/prefix number (1-9), for the tabs on screen. */
  numbers: Map<string, number>;
  /** Windows waiting for you in every project, shown or folded. */
  needYou: number;
}

export const NUMBERED = 9;

export function stripZones({ groups, current, kept, locked = false }: StripInput): StripZones {
  const here = groups.find((g) => g.key === current) ?? groups[0];
  const items: StripItem[] = [];
  const numbers = new Map<string, number>();
  const flat = groups.length < 2;
  for (const g of groups) {
    if (g !== here && !kept.has(g.key)) continue;
    if (g !== here) items.push({ kind: "label", key: g.key, name: g.label });
    for (const window of g.windows) {
      const number = numbers.size < NUMBERED ? numbers.size + 1 : null;
      if (number) numbers.set(window.id, number);
      items.push({ kind: "tab", window, project: g.key, number });
    }
  }
  return {
    chip: here ? { key: here.key, name: here.label, count: here.windows.length, locked } : null,
    items,
    flat,
    numbers,
    needYou: groups.reduce((n, g) => n + g.windows.filter((w) => w.status === "waiting").length, 0),
  };
}
