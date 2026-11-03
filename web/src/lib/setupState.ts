/** The first run's facts, read once per launch. A failed read is null. */
import type { SetupState } from "../../../shared/types.ts";
import { api } from "./api.ts";

let pending: Promise<SetupState | null> | null = null;

/** One request for the window: the gate, the wizard and the terminal share it. */
export function readSetupState(): Promise<SetupState | null> {
  if (!pending) pending = api.setupState().then((s) => s).catch(() => null);
  return pending;
}

/** Tests and `Run the setup again` need the next launch to ask again. */
export function forgetSetupState(): void {
  pending = null;
}

/**
 * `Run the setup again`: the stored flag wins in both directions, so writing it
 * false brings the wizard back on the next load for anybody — a project open or
 * not. The old picker's key goes with it, or a first run would be skipped by a
 * browser that answered that question months ago.
 */
export async function runSetupAgain(deps: {
  set?: (id: string, value: unknown) => Promise<unknown>;
  forget?: () => void;
  reload?: () => void;
} = {}): Promise<void> {
  const set = deps.set ?? api.settingsDoorSet;
  await set("setup.done", false).catch(() => {});
  try { localStorage.removeItem("agentglass.projectChosen"); } catch { /* no storage */ }
  (deps.forget ?? forgetSetupState)();
  (deps.reload ?? (() => window.location.reload()))();
}
