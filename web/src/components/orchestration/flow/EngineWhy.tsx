/*
 * An engine that was picked and cannot take the role says why, and offers the
 * way to the engines page. The picker already disables the options that cannot
 * run, with the reason as a hover; this is the sentence that stays on screen
 * when the engine in force is the one that stopped being ready.
 */
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { agentProvider } from "../../../../../shared/agentKinds.ts";

export function EngineWhy({ engine, readiness }: { engine: string | null | undefined; readiness: readonly EngineReadiness[] | null }) {
  const found = engine ? readiness?.find((r) => r.id === engine) : undefined;
  if (!engine || !found || found.roles.worker.ok) return null;
  const name = agentProvider(engine)?.title ?? engine;
  return (
    <p className="fe-quiet" data-engine-why={engine}>
      {name} cannot take this role here{found.roles.worker.why ? `: ${found.roles.worker.why}` : "."}{" "}
      <button type="button" className="agx-field-link" onClick={() => openSettings("engines")}>Show it</button>
    </p>
  );
}
