import { useMemo, useState } from "react";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { CloseButton } from "../CloseButton.tsx";
import {
  PRESET_PARTS, PRESET_PART_WORDS, PRESET_FLOW_PARTS, applyPreset, parsePresetText, presetFileName, presetNameTaken, presetOf,
  presetPolicyParts, presetSaveParts, presetText, presetWritableParts,
  type PresetFile, type PresetPart, type PresetTarget,
} from "../../../../shared/preset.ts";
import { ruleLine } from "./orchestrationCopy.ts";

/**
 * Presets on the global page: named setups, shipped and the person's own, with
 * what each one sets, the parts toggles, the file preview and download, and an
 * import that shows a file before anything is usable.
 *
 * "Use" saves through the page's own routes, so the validator and the ceiling
 * judge it exactly as they judge a hand edit. A file that does not validate, or
 * asks for more safety than is in force, prints the server's sentence and stays
 * unusable; nothing is written from the preview.
 */
export interface PresetCardsProps {
  /** The policy and flow in force: what a preset applies to. */
  target: PresetTarget;
  /** The project whose flow a file may change; "" is All projects. */
  projectRoot: string;
  shipped?: PresetFile[];
  mine?: PresetFile[];
  busy?: boolean;
  /** The server's sentence, when the last save was refused. */
  note?: string;
  /** Answers null when it saved, or the sentence to show. */
  onApply: (next: PresetTarget) => Promise<string | null>;
  onSaveMine?: (preset: PresetFile) => Promise<string | null>;
  onDeleteMine?: (name: string) => Promise<string | null>;
  /** A panel open from the start; a test and a screenshot show it. */
  open?: "share" | "import" | "new" | null;
  /** The preset that panel is about. */
  openPreset?: string;
  /** Text already in the import box; a paste fills it in the app. */
  importText?: string;
}

const isFlowPart = (p: PresetPart) => PRESET_FLOW_PARTS.includes(p);

/** The blob URL of the last file saved from this page, released when the next one is made (see `download`). */
let lastSavedUrl: string | null = null;

export function PresetCards(p: PresetCardsProps) {
  const shipped = p.shipped ?? [];
  const mine = p.mine ?? [];
  // A person's own card wears the name they gave it: where a shipped setup has the same name, theirs is the card and
  // the shipped one steps aside, so one name picks one setup and no two cards share a key.
  const all = [...shipped.filter((s) => !mine.some((m) => m.name === s.name)), ...mine];
  const [panel, setPanel] = useState<"share" | "import" | "new" | null>(p.open ?? null);
  const [sel, setSel] = useState<string | null>(p.openPreset ?? null);
  const [parts, setParts] = useState<PresetPart[]>(() => {
    const open = all.find((x) => x.name === p.openPreset);
    return open ? presetWritableParts(open) : [];
  });
  const [error, setError] = useState<string | null>(null);
  const [mineName, setMineName] = useState("");
  const [text, setText] = useState(p.importText ?? "");
  const [busy, setBusy] = useState(false);

  const chosen = all.find((x) => x.name === sel) ?? null;
  /** What this preset can be written with: a part it does not carry would make the file its own importer refuses. */
  const writable = chosen ? presetWritableParts(chosen) : [];
  const parsed = useMemo(() => (text.trim() ? parsePresetText(text) : null), [text]);
  const flowHome = p.projectRoot !== "";
  /** A flow belongs to one project: under All projects only the parts below it can be applied. */
  const noFlowHome = (asked: readonly PresetPart[]) => !flowHome && asked.some(isFlowPart);

  const pick = (preset: PresetFile) => { setSel(preset.name); setParts(presetWritableParts(preset)); setError(null); };
  const toggle = (part: PresetPart) => setParts((now) => {
    if (!writable.includes(part)) return now;
    return now.includes(part) ? now.filter((x) => x !== part) : [...PRESET_PARTS].filter((x) => now.includes(x) || x === part);
  });

  /** A dropped or chosen file goes into the same box a paste does, and is checked by the same validator. */
  const takeFile = async (file: File | undefined | null) => {
    if (!file) return;
    setText(await file.text());
    setError(null);
  };

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    const e = await fn();
    setBusy(false);
    setError(e);
    return e;
  };

  /** What pressing Use would save, or why it cannot even be tried here. */
  const use = async (preset: PresetFile, applied: PresetPart[]) => {
    if (noFlowHome(applied)) {
      setError("A flow belongs to one project: pick a project above, or apply the policy parts only.");
      return;
    }
    await run(async () => {
      const next = applyPreset(preset, p.target, applied);
      if (!next.ok) return next.error;
      return p.onApply(next.value);
    });
  };

  /** The way out the refusal offers, in one press: the same setup, without the parts that need a project. */
  const policyOnly = (preset: PresetFile, asked: readonly PresetPart[]) => {
    setParts(presetPolicyParts(asked));
    void use(preset, presetPolicyParts(asked));
  };

  const saveMine = () => {
    const name = mineName.trim();
    if (!name || !p.onSaveMine) return;
    if (presetNameTaken(name, shipped)) {
      setError(`A shipped preset is already called “${name}”: give yours another name.`);
      return;
    }
    // Saved with the parts All projects can carry, so a machine-wide preset never holds a project's roster.
    const includes = presetSaveParts(flowHome);
    void run(() => p.onSaveMine!(presetOf(p.target, name, includes)));
  };

  const download = (preset: PresetFile) => {
    // The blob URL outlives this press: revoking it at once cancels the download in Firefox, so the one before it is released here instead.
    if (lastSavedUrl) URL.revokeObjectURL(lastSavedUrl);
    const blob = new Blob([presetText(preset, parts)], { type: "application/json" });
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    lastSavedUrl = href;
    a.href = href;
    a.download = presetFileName(preset.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <section className="agx-flow-preset-block" aria-label="Presets" data-presets>
      <header className="agx-flow-preset-block-top">
        <h2>Presets</h2>
        <p>Named setups to start from. Nothing running is moved, and a preset never carries a key.</p>
        <span className="agx-flow-preset-sp" />
        <Button onClick={() => { setPanel("new"); setError(null); }}>Save mine</Button>
        <Button onClick={() => { setPanel("import"); setError(null); }}>Import a preset</Button>
      </header>

      <div className="agx-flow-preset-cards" role="listbox" aria-label="Presets">
        {all.map((preset) => (
          <button key={preset.name} type="button" role="option" aria-selected={sel === preset.name}
            className="agx-flow-preset-card" data-preset={preset.name} data-yours={mine.includes(preset) ? "" : undefined}
            onClick={() => pick(preset)}>
            <b>{preset.name}</b>
            <span>{mine.includes(preset) ? "Yours" : "Shipped"}</span>
            <small>{preset.includes.map((x) => PRESET_PART_WORDS[x].label).join(" \u00b7 ") || "Nothing yet"}</small>
          </button>
        ))}
        {all.length === 0 && <p className="agx-flow-preset-empty">No preset here yet: save the setup you have, or import one.</p>}
      </div>

      {chosen && (
        <div className="agx-flow-preset-detail" data-detail={chosen.name}>
          <div className="agx-flow-preset-parts">
            {PRESET_PARTS.map((part) => (
              <span key={part} className="agx-flow-preset-part" data-part={part} data-on={parts.includes(part) ? "" : undefined}>
                {PRESET_PART_WORDS[part].label}
              </span>
            ))}
          </div>
          {chosen.policy?.rules?.length ? (
            <ul className="agx-flow-preset-rules">
              {chosen.policy.rules.map((r) => <li key={r.id}>{ruleLine(r)}</li>)}
            </ul>
          ) : null}
          <div className="agx-flow-preset-actions">
            <Button tone="primary" disabled={busy || parts.length === 0 || noFlowHome(parts)} onClick={() => void use(chosen, parts)}>Use this preset</Button>
            <Button onClick={() => { setPanel("share"); setError(null); }}>Share or download</Button>
            {mine.includes(chosen) && p.onDeleteMine && (
              <Button onClick={() => void run(() => p.onDeleteMine!(chosen.name))}>Delete</Button>
            )}
          </div>
          {noFlowHome(parts) && (
            <p className="agx-flow-preset-hint" data-flow-refused>A flow belongs to one project.{" "}
              <button type="button" className="agx-flow-preset-link" onClick={() => policyOnly(chosen, parts)}>Apply the policy parts only</button>
            </p>
          )}
        </div>
      )}

      {panel === "share" && chosen && (
        <div className="agx-flow-preset-panel" role="group" aria-label="Share this preset" data-panel="share">
          <header><b>Share “{chosen.name}”</b><span className="agx-flow-preset-sp" /><CloseButton title="Close the share panel" onClick={() => setPanel(null)} /></header>
          <p className="agx-flow-preset-hint">Keys, sign-ins, projects, paths and history are never inside one. What is switched off is not written into the file.</p>
          <div className="agx-flow-preset-toggles">
            {PRESET_PARTS.map((part) => (
              <label key={part} className="agx-flow-preset-toggle">
                <input type="checkbox" checked={parts.includes(part)} onChange={() => toggle(part)} data-toggle={part}
                  disabled={!writable.includes(part)} />
                <span><b>{PRESET_PART_WORDS[part].label}</b><small>{PRESET_PART_WORDS[part].hint}</small></span>
              </label>
            ))}
          </div>
          <pre className="agx-flow-preset-file" data-file>{presetText(chosen, parts)}</pre>
          <div className="agx-flow-preset-actions">
            <Button tone="primary" onClick={() => download(chosen)}>Download .agxpreset</Button>
            <Button onClick={() => void navigator.clipboard?.writeText(presetText(chosen, parts)).catch(() => null)}>Copy as text</Button>
          </div>
        </div>
      )}

      {panel === "import" && (
        <div className="agx-flow-preset-panel" role="group" aria-label="Import a preset" data-panel="import">
          <header><b>Import a preset</b><span className="agx-flow-preset-sp" /><CloseButton title="Close the import panel" onClick={() => setPanel(null)} /></header>
          <div data-drop onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void takeFile(e.dataTransfer.files[0]); }}>
            <p className="agx-flow-preset-hint">Drop a .agxpreset file here, or paste its text. Nothing is applied until you press Use.</p>
            <textarea className="agx-flow-preset-in" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text of a preset" aria-label="The preset's text" />
            <label className="agx-flow-preset-link">Choose a .agxpreset file…
              <input type="file" accept=".agxpreset,application/json" className="sr-only" data-file-input onChange={(e) => void takeFile(e.target.files?.[0])} />
            </label>
          </div>
          {parsed && !parsed.ok && <p className="agx-flow-preset-err" role="alert" data-import-error>{parsed.error}</p>}
          {parsed?.ok && (
            <div className="agx-flow-preset-detail" data-import-preview>
              <b>{parsed.value.name}</b>
              <div className="agx-flow-preset-parts">
                {parsed.value.includes.map((part) => <span key={part} className="agx-flow-preset-part" data-on="">{PRESET_PART_WORDS[part].label}</span>)}
              </div>
            </div>
          )}
          {parsed?.ok && noFlowHome(parsed.value.includes) && (
            <p className="agx-flow-preset-hint" data-import-flow>A flow belongs to one project.{" "}
              <button type="button" className="agx-flow-preset-link" onClick={() => policyOnly(parsed.value, parsed.value.includes)}>Apply the policy parts only</button>
            </p>
          )}
          <div className="agx-flow-preset-actions">
            <Button tone="primary" disabled={!parsed?.ok || busy || (parsed?.ok === true && noFlowHome(parsed.value.includes))}
              onClick={() => { if (parsed?.ok) void use(parsed.value, parsed.value.includes); }}>Use this preset</Button>
          </div>
        </div>
      )}

      {panel === "new" && (
        <div className="agx-flow-preset-panel" role="group" aria-label="Save this setup as a preset" data-panel="new">
          <header><b>Save this setup</b><span className="agx-flow-preset-sp" /><CloseButton title="Close the save panel" onClick={() => setPanel(null)} /></header>
          <p className="agx-flow-preset-hint">It saves the orchestrator's and workers' engines, the limits, the rules, the safety and the flow you have now.</p>
          <input className={`${INPUT} w-full`} style={{ ...INPUT_STYLE, marginTop: 8 }} value={mineName} onChange={(e) => setMineName(e.target.value)} placeholder="e.g. Night shift" aria-label="The preset's name" />
          {!flowHome && (
            <p className="agx-flow-preset-hint">Under All projects it saves the parts every project shares: engines, limits, rules, safety and refusals. A flow belongs to one project, so it stays out.</p>
          )}
          <div className="agx-flow-preset-actions">
            <Button tone="primary" disabled={!mineName.trim() || !p.onSaveMine || busy} onClick={saveMine}>Save preset</Button>
          </div>
        </div>
      )}

      {(error || p.note) && <p className="agx-flow-preset-err" role="alert">{error || p.note}</p>}
    </section>
  );
}
