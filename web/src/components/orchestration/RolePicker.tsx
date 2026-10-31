import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { Chip, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import type { EngineChoice } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { EngineTiles } from "./EngineTiles.tsx";
import { DEFAULT_MODEL, pickEngine, pickModel } from "./orchestrationCopy.ts";

/**
 * One job's choice, as two steps of tiles: the engine, then its model. Each
 * press saves at once (the page shows what it saved, with Undo), so there is no
 * Save here. The main agent's models are the ones the open main agent offers;
 * a worker's model is typed in (kept when the field loses focus) with the
 * engine's own models offered as suggestions, read once when the engine changes.
 */
export function RolePicker({ id, role, word, current, readiness, lock, models, modelNote, disabled, onPick }: {
  id: string;
  role: "orchestrator" | "worker";
  /** "main agent", "builders": what the heading says the choice is for. */
  word: string;
  current: EngineChoice;
  readiness: readonly EngineReadiness[] | null;
  lock?: { engine: string; why: string };
  /** The main agent's models, or null when the model is typed (workers). */
  models: { id: string; label: string }[] | null;
  /** Said under the model step when there is nothing to pick from. */
  modelNote: string;
  disabled: boolean;
  onPick: (c: EngineChoice) => void;
}) {
  const suggestions = useEngineModels(models ? "" : current.engine);
  return (
    <div className="grid gap-3" data-picker={id}>
      <div className="grid gap-2">
        <div className="text-[11px]" style={{ color: "var(--text3)" }}>Which engine runs the {word}</div>
        <EngineTiles role={role} readiness={readiness} lock={lock} selected={current.engine} label={`Engine for the ${word}`}
          onPick={(engine, options) => { if (disabled) return; const c = pickEngine(options, current, engine); if (c) onPick(c); }} />
      </div>
      <div className="grid gap-2">
        <div className="text-[11px]" style={{ color: "var(--text3)" }}>Which model</div>
        {models ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Model for the ${word}`}>
            {[{ id: "", label: DEFAULT_MODEL }, ...models].map((m) => (
              <Chip key={m.id} on={current.model === m.id} resting disabled={disabled || models.length === 0}
                onClick={() => { const c = pickModel(current, m.id); if (c) onPick(c); }}>{m.label}</Chip>
            ))}
          </div>
        ) : (
          <input defaultValue={current.model} key={`${id}:${current.engine}:${current.model}`} spellCheck={false} placeholder="its default model" list={`${id}-models`}
            aria-label={`Model for the ${word}`} disabled={disabled}
            onBlur={(e) => { const c = pickModel(current, e.target.value.trim()); if (c) onPick(c); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
            className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 260 }} />
        )}
        {!models && suggestions.length > 0 && (
          <datalist id={`${id}-models`}>{suggestions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
        )}
        {modelNote && <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>{modelNote}</p>}
      </div>
    </div>
  );
}

/** The engine's models; a failure or an engine with none is an empty list. */
function useEngineModels(engine: string): { id: string; label: string }[] {
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    setList([]);
    if (!engine) return;
    let live = true;
    api.engineModels(engine).then((r) => { if (live) setList(r.models ?? []); }, () => {});
    return () => { live = false; };
  }, [engine]);
  return list;
}
