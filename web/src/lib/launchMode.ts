/**
 * The global launch mode as the web knows it: read once, on first use, and
 * replaced when the Settings form saves. No poll — the only writer that
 * matters while a page is open is that form, and it says so here.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { DEFAULT_LAUNCH_DENY, type LaunchPermissions } from "../../../shared/launchModes.ts";

let current: LaunchPermissions | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<(p: LaunchPermissions) => void>();

export function setLaunchPermissions(p: LaunchPermissions): void {
  current = p;
  for (const fn of listeners) fn(p);
}

/** Null until the first answer. A failed read stays null: the select then says
 *  "the global setting" without naming one rather than guessing it. */
export function useLaunchPermissions(): LaunchPermissions | null {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    asked ??= api.launchPermissions()
      .then((r) => { if (r.ok) setLaunchPermissions({ mode: r.mode, deny: r.deny ?? [...DEFAULT_LAUNCH_DENY] }); })
      .catch(() => { asked = null; });
    return () => { listeners.delete(setP); };
  }, []);
  return p;
}
