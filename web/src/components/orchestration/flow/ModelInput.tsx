import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import type { EngineChoice } from "../../../../../shared/orchestration.ts";
import { ENGINE_CHOICES } from "./flowScreenCopy.ts";

/**
 * The model of an engine choice, picked from the models that engine is offered
 * and saved at once. The first option is the engine's own default (an empty
 * model). A model already saved that the list does not know stays selectable,
 * so opening a block never rewrites what a person set by other means.
 * The page's "This block" and the Flow editor both draw this one.
 */
/**
 * The models an engine is offered: what the installed CLI lists (`opencode models`, cached by the server),
 * narrowed to the OpenCode plans (`opencode/`, `opencode-go/`: the other providers need keys this app does not
 * manage), and the short built-in list until that answers or when it has nothing. Only OpenCode has a list to read;
 * the other engines keep the built-in one.
 */
export function useOffered(engine: string | undefined): string[] {
  const builtin = ENGINE_CHOICES.find((e) => e.id === engine)?.models ?? [];
  const [live, setLive] = useState<string[]>([]);
  useEffect(() => {
    setLive([]);
    if (engine !== "opencode") return;
    let gone = false;
    api.engineModels(engine).then((r) => { if (!gone && r.ok) setLive(r.models.map((m) => m.id).filter((id) => /^opencode(-go)?\//.test(id))); }).catch(() => {});
    return () => { gone = true; };
  }, [engine]);
  return live.length ? live : builtin;
}

export function ModelInput(p: { choice: EngineChoice | null; label: string; disabled: boolean; onCommit: (c: EngineChoice) => void; note?: string; wide?: boolean }) {
  const c = p.choice;
  const offered = useOffered(c?.engine);
  const saved = c?.model ?? "";
  // OpenCode takes provider/model. A name saved without its provider is shown as the Go model of that
  // name when the list has one; what is saved stays untouched until the person picks something else.
  const goName = `opencode-go/${saved}`;
  const current = c?.engine === "opencode" && !offered.includes(saved) && offered.includes(goName) ? goName : saved;
  const options = current && !offered.includes(current) ? [...offered, current] : offered;
  return (
    <label className="agx-flow-ctl" data-ctl="model">
      <span className="agx-flow-fk">Model{p.note && <small>{p.note}</small>}</span>
      <select value={current} aria-label={p.label} disabled={p.disabled || !c}
        onChange={(e) => { if (c && e.target.value !== current) p.onCommit({ engine: c.engine, model: e.target.value }); }}
        className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: p.wide ? "100%" : 210 }}>
        <option value="">its default model</option>
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}
