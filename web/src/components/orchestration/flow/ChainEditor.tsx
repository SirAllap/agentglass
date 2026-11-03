/*
 * The chain a role of a person's own runs on, in the order it is tried, and the
 * little engine-and-model picker that adds to it. Shared by the role editor
 * and the add sheet so both say the same thing about a chain.
 */
import { CHAIN_MAX, type Chain } from "../../../../../shared/orchestration.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { ENGINE_CHOICES, engineName } from "./flowScreenCopy.ts";
import { useOffered } from "./ModelInput.tsx";

/** The mockup's one-letter engine badge, with the three different hues it gives them. */
const LETTER: Record<string, string> = { claude: "C", opencode: "O", codex: "X" };
const Glyph = ({ engine }: { engine: string }) => <span className="fe-eg" data-engine={engine} aria-hidden="true">{LETTER[engine] ?? "?"}</span>;

function FallbackRow({ c, i, onEngine, onModel, onMove, onRemove, canRemove }: {
  c: { engine: string; model: string };
  i: number;
  onEngine: (engine: string) => void;
  onModel: (model: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const offered = useOffered(c.engine);
  const options = offered.includes(c.model) ? offered : [...offered, c.model];
  return (
    <div className="fe-chainrow" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("text/plain")) e.preventDefault(); }}
      onDrop={(e) => { const from = Number(e.dataTransfer.getData("text/plain")); if (from > 0) onMove(from, i); }}>
      <span className="fe-n">{i + 1}</span>
      <Glyph engine={c.engine} />
      <span className="fe-selwrap fe-fbe"><select aria-label={`Engine for fallback ${i}`} value={c.engine} onChange={(e) => onEngine(e.target.value)}>{ENGINE_CHOICES.map((x) => <option key={x.id} value={x.id}>{engineName(x.id)}</option>)}</select><FlowIcon name="chev" size={12} /></span>
      <span className="fe-selwrap fe-fbm"><select aria-label={`Model for fallback ${i}`} value={c.model} onChange={(e) => onModel(e.target.value)}>{options.map((m) => <option key={m} value={m}>{m}</option>)}</select><FlowIcon name="chev" size={12} /></span>
      <span className="fe-sp" />
      <button className="fe-sq fe-gr" type="button" aria-label={`Reorder fallback ${i}`} title="Drag to reorder, or press up and down"
        onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); onMove(i, i - 1); } if (e.key === "ArrowDown") { e.preventDefault(); onMove(i, i + 1); } }}><FlowIcon name="grip" size={ICON.xs} /></button>
      <button className="fe-sq" type="button" aria-label={`Remove ${c.model}`} title="Remove" disabled={!canRemove} onClick={onRemove}><FlowIcon name="x" size={ICON.xs} /></button>
    </div>
  );
}

export function ChainList({ chain, onChange }: { chain: Chain; onChange: (c: Chain) => void }) {
  const move = (from: number, to: number) => {
    if (from < 1 || to < 1 || from >= chain.length || to >= chain.length || from === to) return;
    const next = [...chain];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    onChange(next);
  };
  // The next engine and its own default, so a fallback is added in one press and then tuned in its row.
  const nextChoice = ENGINE_CHOICES.map((e) => ({ engine: e.id, model: e.models[0] ?? "" }))
    .find((c) => !chain.some((x) => x.engine === c.engine && x.model === c.model));
  return (
    <div className="fe-chainwrap">
      <div className="fe-chainlist">
        {chain.map((c, i) => i === 0 ? (
          <div key={`${c.engine}-${c.model}`} className="fe-chainrow" data-first>
            <span className="fe-n">1</span><Glyph engine={c.engine} /><code>{c.model.slice(c.model.lastIndexOf("/") + 1)}</code>
            <span className="fe-sp" /><span className="fe-tag">Main</span>
          </div>
        ) : (
          <FallbackRow key={`${i}-${c.engine}-${c.model}`} c={c} i={i} canRemove={chain.length > 1}
            onEngine={(e) => onChange(chain.map((x, k) => (k === i ? { ...x, engine: e, model: ENGINE_CHOICES.find((y) => y.id === e)?.models[0] ?? "" } : x)))}
            onModel={(m) => onChange(chain.map((x, k) => (k === i ? { ...x, model: m } : x)))}
            onMove={move} onRemove={() => onChange(chain.filter((_, k) => k !== i))} />
        ))}
      </div>
      {chain.length < CHAIN_MAX && (
        <button className="fe-chainadd" type="button" disabled={!nextChoice} onClick={() => nextChoice && onChange([...chain, nextChoice])}><FlowIcon name="plus" size={ICON.xs} />Add a fallback</button>
      )}
    </div>
  );
}
