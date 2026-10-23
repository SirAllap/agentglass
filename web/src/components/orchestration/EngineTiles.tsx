import type { EngineReadiness } from "../../../../shared/types.ts";
import { EngineTile } from "./EngineTile.tsx";
import { engineOptions, type EngineOption } from "./orchestrationCopy.ts";

/**
 * Every engine the app knows as a big tile to press. An engine that cannot do
 * the role is listed, disabled, and says why once, on its own tile; pressing
 * it does nothing. `onPick` is only called with an engine the tile list lets
 * through, and the first tile that can be pressed takes the cursor when a
 * picker opens.
 */
export function EngineTiles({ role, readiness, lock, selected, label, onPick }: {
  role: "orchestrator" | "worker";
  readiness: readonly EngineReadiness[] | null;
  lock?: { engine: string; why: string };
  selected?: string;
  label: string;
  onPick: (engine: string, options: readonly EngineOption[]) => void;
}) {
  const options = engineOptions(role, readiness, lock);
  const first = options.find((o) => !o.disabled)?.value;
  return (
    <div className="agx-tiles" role="group" aria-label={label}>
      {options.map((o) => (
        <EngineTile key={o.value} engine={o.value} role={role} readiness={readiness} selected={o.value === selected}
          disabled={!!o.disabled} reason={o.hint} first={o.value === first}
          onPick={() => { if (!o.disabled) onPick(o.value, options); }} />
      ))}
    </div>
  );
}
