import type { TmuxWindow } from "../../../shared/types.ts";
import { nextWaiting } from "./windowSwitcher.ts";

/**
 * Where Ctrl+Alt+N goes: the next window waiting for you after the active one,
 * across every project, wrapping round. Null when nothing is waiting.
 */
export function needYouJump(windows: readonly TmuxWindow[], active: string | null): string | null {
  const i = nextWaiting(windows, windows.findIndex((w) => w.id === active));
  return i < 0 ? null : windows[i]!.id;
}
