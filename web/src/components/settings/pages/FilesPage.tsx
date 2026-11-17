import { useCallback, useState } from "react";
import { DEFAULT_PREFS, THUMB_MAX, THUMB_MIN, TEXT_MAX, TEXT_MIN, readPrefs, writePrefs, type Prefs } from "../../../lib/finderMiller.ts";
import { Button, Segmented } from "../../workspace/Chrome.tsx";
import { Switch } from "../../orchestration/flow/Switch.tsx";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, MoreOptions, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { DangerAction, instantSave } from "../save/index.ts";
import { FILES_ROWS } from "./pageRows.ts";
import type { PageCtx } from "./ctx.ts";

/** Same key the machine panel's Finder reads. */
export const FINDER_PREFS_KEY = "agentglass.finder.machine.prefs";
/** Fired after a write here so an open Finder re-reads its preferences. */
export const FINDER_PREFS_EVENT = "agx:finder-prefs";

const load = (): Prefs => { try { return readPrefs(localStorage.getItem(FINDER_PREFS_KEY)); } catch { return DEFAULT_PREFS; } };
const COPY = Object.fromEntries(FILES_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });
type Flag = "peek" | "preview" | "autoplay" | "renderDocs" | "sizes" | "mirror" | "hidden" | "f1" | "foldersFirst";

/** Files (the Finder's view preferences) on the new shell. Density lives on Appearance. */
export function FilesPage({ c }: { c: PageCtx }) {
  const [p, setP] = useState<Prefs>(load);
  const write = useCallback((patch: Partial<Prefs>) => {
    const next = { ...load(), ...patch };
    try { localStorage.setItem(FINDER_PREFS_KEY, writePrefs(next)); window.dispatchEvent(new Event(FINDER_PREFS_EVENT)); } catch { /* a private window forgets; the Finder still works */ }
    setP(next);
  }, []);
  /** Saves at once with Undo: the undo writes the old value back through the same door. */
  const save = (patch: Partial<Prefs>) => {
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, p[k as keyof Prefs]])) as Partial<Prefs>;
    instantSave(JSON.stringify(old), JSON.stringify(patch), (s) => write(JSON.parse(s) as Partial<Prefs>));
  };
  const flag = (id: string, k: Flag) => <Switch on={p[k]} label={COPY[id].label} onChange={(v) => save({ [k]: v } as Partial<Prefs>)} />;
  const thumb = p.thumb <= 48 ? "small" : p.thumb >= 128 ? "large" : "medium";
  const stepper = (value: string, dec: () => void, inc: () => void, canDec: boolean, canInc: boolean, what: string) => (
    <span className="flex items-center gap-2">
      <Button onClick={dec} disabled={!canDec} aria-label={`Smaller ${what}`}>−</Button>
      <span className="t-mono text-[12px] min-w-[44px] text-center" style={{ color: "var(--text)" }}>{value}</span>
      <Button onClick={inc} disabled={!canInc} aria-label={`Larger ${what}`}>+</Button>
    </span>
  );
  return (
    <SettingsPage title="Files" purpose="How the Finder opens folders and files, and how it looks."
      sections={[
        { id: "browsing", title: "Browsing", kind: "normal", body: (
          <Section id="browsing" title="Browsing">
            {(["finder.hidden", "finder.foldersFirst", "finder.sizes", "finder.preview", "finder.autoplay", "finder.renderDocs"] as const).map((id) => {
              const k = ({ "finder.hidden": "hidden", "finder.foldersFirst": "foldersFirst", "finder.sizes": "sizes", "finder.preview": "preview", "finder.autoplay": "autoplay", "finder.renderDocs": "renderDocs" } as const)[id];
              return <SettingRow key={id} kind="control" {...row(id)} control={flag(id, k)} />;
            })}
          </Section>) },
        { id: "look", title: "Sorting and look", kind: "normal", body: (
          <Section id="look" title="Sorting and look">
            <SettingRow kind="control" {...row("finder.sort")} control={<Segmented track label="Default sort" value={p.sortKey} onChange={(v) => save({ sortKey: v as Prefs["sortKey"] })} options={[{ id: "name", label: "Name" }, { id: "size", label: "Size" }, { id: "modified", label: "Modified" }, { id: "type", label: "Type" }]} />} />
            <SettingRow kind="control" {...row("finder.textSize")} control={stepper(`${p.textSize}px`, () => save({ textSize: Math.max(TEXT_MIN, p.textSize - 1) }), () => save({ textSize: Math.min(TEXT_MAX, p.textSize + 1) }), p.textSize > TEXT_MIN, p.textSize < TEXT_MAX, "text")} />
            <SettingRow kind="control" {...row("finder.thumb")} control={<Segmented track label="Thumbnail size" value={thumb} onChange={(v) => save({ thumb: Math.min(THUMB_MAX, Math.max(THUMB_MIN, v === "small" ? 48 : v === "large" ? 128 : 64)) })} options={[{ id: "small", label: "Small" }, { id: "medium", label: "Medium" }, { id: "large", label: "Large" }]} />} />
          </Section>) },
        { id: "actions", title: "Actions", kind: "normal", body: (
          <Section id="actions" title="Actions">
            <SettingRow kind="link" {...row("finder.actions")} linkText="Back to the app" onOpen={c.onClose} />
          </Section>) },
        { id: "more", title: "More options", kind: "more", body: (
          <MoreOptions>
            <SettingRow kind="control" {...row("finder.peek")} control={flag("finder.peek", "peek")} />
            <SettingRow kind="control" {...row("finder.mirror")} control={flag("finder.mirror", "mirror")} />
            <SettingRow kind="control" {...row("finder.f1")} control={flag("finder.f1", "f1")} />
          </MoreOptions>) },
        { id: "danger", title: "Danger zone", kind: "danger", body: (
          <DangerZone>
            <SettingRow kind="control" {...row("finder.reset")} control={<DangerAction label="Reset finder settings" onConfirm={() => write({ ...DEFAULT_PREFS })} />} />
          </DangerZone>) },
      ]} />
  );
}
