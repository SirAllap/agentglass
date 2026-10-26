/*
 * Which engines a hand-off can start and which permission modes each has a flag
 * for, read once from the server. The default engine is what a plain press
 * starts (agentticket.ts issueArgv), so a tooltip can name it.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { LAUNCH_MODES, type LaunchMode } from "../../../shared/launchModes.ts";

export type HandoffEngines = {
  def: string;
  engines: { id: string; title: string }[];
  flags: { overrides: Record<string, Record<string, string[]>>; builtin: Record<string, Record<string, string[]>> };
};

let cache: HandoffEngines | null = null;
let asked: Promise<void> | null = null;
const subs = new Set<(e: HandoffEngines) => void>();

/** Null until the first answer; a failed read stays null and the menu offers only what needs no list. */
export function useHandoffEngines(): HandoffEngines | null {
  const [e, setE] = useState(cache);
  useEffect(() => {
    subs.add(setE);
    asked ??= Promise.all([api.workerRoles(), api.launchFlags()]).then(([roles, flags]) => {
      if (!roles.ok || !flags.ok) return;
      cache = {
        def: roles.roles.builder?.provider ?? "claude",
        engines: (roles.providers ?? []).filter((p) => p.installed).map((p) => ({ id: p.id, title: p.title })),
        flags: { overrides: flags.overrides, builtin: flags.builtin },
      };
      subs.forEach((f) => f(cache!));
    }).catch(() => { asked = null; });
    return () => { subs.delete(setE); };
  }, []);
  return e;
}

/** Claude takes all four; any other CLI only those it has a flag for (launchperm.ts launchFlags). */
export function modesFor(e: HandoffEngines, kind: string): LaunchMode[] {
  if (kind === "claude") return [...LAUNCH_MODES];
  return LAUNCH_MODES.filter((m) => (e.flags.overrides[kind]?.[m] ?? e.flags.builtin[kind]?.[m] ?? []).length > 0);
}

export const engineTitle = (e: HandoffEngines | null, id: string): string => e?.engines.find((p) => p.id === id)?.title ?? id;

/** The engine a plain hand-off starts, by name; "your agent" before the engines are known. */
export const agentName = (e: HandoffEngines | null): string => (e ? engineTitle(e, e.def) : "your agent");

/** "Opens OpenCode in a terminal", or the plain sentence before the engines are known. */
export const opensIn = (e: HandoffEngines | null): string => `Opens ${e ? engineTitle(e, e.def) : "your default engine"} in a terminal`;
