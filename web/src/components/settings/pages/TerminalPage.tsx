import { useEffect, useState } from "react";
import { setting } from "../../../lib/settingsRegistry.ts";
import { api } from "../../../lib/api.ts";
import { minutesAgo } from "../../../lib/format.ts";
import { type PaneMarker } from "../../../lib/paneActionsPref.ts";
import { type RendererPref } from "../../../lib/termRenderer.ts";
import { TERM_FONTS, fontAvailable, DEFAULT_SIZE, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, DEFAULT_LINE_HEIGHT, LINE_HEIGHT_MAX, CURSORS, setRightClickPaste, SCROLLBACK_SIZES, OTHER_LINKS, NOTE_EDITORS, type CursorStyle, type NoteEditor, type OtherLinks } from "../../../lib/termPrefs.ts";
import { chordLabel, appChordFor } from "../../../lib/keybindings.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { savePaneField } from "../../../lib/paneEngineSave.ts";
import { restoredNote } from "../../../lib/restoredNote.ts";
import { Select } from "../../Select.tsx";
import { LINE, Button, Segmented } from "../../workspace/Chrome.tsx";
import { Switch } from "../../orchestration/flow/Switch.tsx";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { DangerAction, ListEditor, TextCommitField, instantSave, pushSaveToast } from "../save/index.ts";
import { TERMINAL_ROWS } from "./terminalRows.ts";
import type { PageCtx } from "./ctx.ts";

const COPY = Object.fromEntries(TERMINAL_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });

type Tmux = Awaited<ReturnType<typeof api.tmuxStatus>>;

/** Saves at once and offers Undo through the same setter. */
function useSave<T>(old: T, set: (v: T) => void) {
  return (next: T) => instantSave(old, next, set);
}

/** The Terminal page on the new shell: person settings only; engine and binary rows live under Advanced. */
export function TerminalPage({ c }: { c: PageCtx }) {
  const [tmux, setTmux] = useState<Tmux | null>(null);
  const [tmuxDown, setTmuxDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const load = () => api.tmuxStatus().then((r) => { setTmux(r); setTmuxDown(false); }).catch(() => setTmuxDown(true));
  useEffect(() => { if (c.open) void load(); }, [c.open]);

  const setRenderer = (v: RendererPref) => { setting("terminal.renderer").set(v); c.setRenderer(v); };
  const setFont = (v: string) => { setting("terminal.font").set(v); c.setTermFontState(v); };
  const setSize = (n: number) => { setting("terminal.fontSize").set(n); c.setTermSizeState(n); };
  const setLine = (n: number) => { setting("terminal.lineHeight").set(n); c.setTermLineState(n); };
  const setCursor = (v: CursorStyle) => { setting("terminal.cursor").set(v); c.setTermCursorState(v); };
  const setPaneBar = (v: typeof c.paneActs) => { setting("terminal.paneBar").set(v); c.setPaneActs(v); };
  const setMarker = (v: PaneMarker) => { setting("terminal.paneBarMarker").set(v); c.setPaneMark(v); };
  const setFfm = (v: boolean) => { setting("terminal.focusFollowsMouse").set(v); c.setFfm(v); };
  const setCopy = (v: boolean) => { setting("terminal.copyOnSelect").set(v); c.setCopySel(v); };
  const setRc = (v: boolean) => { setRightClickPaste(v); c.setRcPaste(v); };
  const setGroups = (v: boolean) => { setting("terminal.tabGroups").set(v); c.setGroupsOn(v); };
  const setRules = (v: string) => { setting("terminal.tabGroupRules").set(v); c.setGroupRules(v); };
  const setScroll = (n: number) => { setting("terminal.scrollback").set(n); c.setScrollbackState(n); };
  const setWords = (v: string) => { setting("terminal.wordSeparators").set(v); c.setWordSepState(v); };
  const setFab = (v: typeof c.benchFab) => setting("terminal.benchButton").set(v);
  const setBenchLinks = (v: boolean) => { setting("terminal.benchLinks").set(v); c.setBenchLnk(v); };
  const setOther = (v: OtherLinks) => { setting("terminal.otherLinks").set(v); c.setOtherLnk(v); };
  const setNote = (v: NoteEditor) => { setting("terminal.noteEditor").set(v); c.setNoteEd(v); };

  const sv = {
    renderer: useSave(c.renderer, setRenderer), font: useSave(c.termFont, setFont), size: useSave(c.termSize, setSize),
    line: useSave(c.termLine, setLine), cursor: useSave(c.termCursor, setCursor), paneBar: useSave(c.paneActs, setPaneBar),
    marker: useSave(c.paneMark, setMarker), ffm: useSave(c.ffm, setFfm), copy: useSave(c.copySel, setCopy), rc: useSave(c.rcPaste, setRc),
    groups: useSave(c.groupsOn, setGroups), scroll: useSave(c.scrollback, setScroll), fab: useSave(c.benchFab, setFab),
    benchLinks: useSave(c.benchLnk, setBenchLinks), other: useSave(c.otherLnk, setOther), note: useSave(c.noteEd, setNote),
  };

  /** Restore and Resume save at once through the engine door; a failure puts the old value back. */
  const saveEngine = async (field: { restore: boolean } | { resume: "lazy" | "all" }, what: string, undo: typeof field) => {
    setBusy(true); setSaid(null);
    const r = await savePaneField(api.tmuxSettingsSave, field, what);
    if (!r.ok) setSaid(r.error);
    else pushSaveToast("Saved", () => { void savePaneField(api.tmuxSettingsSave, undo, what).then(() => load()); });
    await load(); setBusy(false);
  };
  const restoreAction = (action: "capture" | "restore" | "clear") => {
    setBusy(true); setSaid(null);
    api.tmuxRestoreAction(action, (tmux?.resumeMode as "lazy" | "all") ?? "lazy")
      .then((r) => setSaid(!r.ok ? (r.error ?? "That did not work.") : action === "restore" ? restoredNote(r.restored ?? 0) : action === "capture" ? "Layout captured." : "Saved layout cleared."))
      .catch(() => setSaid("Can't reach the terminal engine right now."))
      .finally(() => { void load(); setBusy(false); });
  };
  const reset = () => {
    setBusy(true); setSaid(null);
    api.tmuxReset().then((r) => setSaid(r.ok ? "Done" : (r.error ?? "Reset failed."))).catch(() => setSaid("Can't reach the terminal engine right now."))
      .finally(() => { void load(); setBusy(false); });
  };

  const stepper = (value: string, dec: () => void, inc: () => void, canDec: boolean, canInc: boolean, what: string) => (
    <span className="flex items-center gap-2">
      <Button onClick={dec} disabled={!canDec} aria-label={`Smaller ${what}`}>−</Button>
      <span className="t-mono text-[12px] min-w-[44px] text-center" style={{ color: "var(--text)" }}>{value}</span>
      <Button onClick={inc} disabled={!canInc} aria-label={`Larger ${what}`}>+</Button>
    </span>
  );
  const seg = <T extends string>(label: string, value: T, options: readonly { id: T; label: string }[], onChange: (v: T) => void) =>
    <Segmented track label={label} value={value} options={options} onChange={onChange} />;
  const sw = (label: string, on: boolean, onChange: (v: boolean) => void, disabled?: boolean) => <Switch on={on} label={label} onChange={onChange} disabled={disabled} />;
  const round = (n: number) => Math.round(n * 100) / 100;
  const fonts = TERM_FONTS.filter((f) => f.bundled || fontAvailable(f.family)).map((f) => ({ value: f.id, label: f.name }));
  const face = TERM_FONTS.find((f) => f.id === c.termFont);
  /* The line you are choosing between, drawn in the face you chose. */
  const fontPreview = (
    <div aria-label="How the chosen face looks" className="whitespace-pre overflow-x-auto"
      style={{ fontFamily: face?.stack || undefined, fontSize: `${c.termSize}px`, lineHeight: 1.35, color: "var(--text)" }}>
      {"$ git rebase --continue\n"}
      <span style={{ color: "var(--success-ink)" }}>{"+ 0Oo l1I |¦ <>= != -> =~ {}[]()\n"}</span>
      <span style={{ color: "var(--text3)" }}>{"  1234567890  .,;:'\"`  ~^*&%$#@"}</span>
    </div>
  );
  const down = tmuxDown && (
    <div role="status" className="px-3 py-2.5 text-[12px] flex items-center gap-2" style={{ color: "var(--text2)", borderTop: LINE }}>
      Can't reach the terminal engine right now.
      <Button onClick={() => void load()}>Retry</Button>
    </div>
  );
  const note = said && <div role="status" className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)", borderTop: LINE }}>{said}</div>;

  return (
    <SettingsPage title="Terminal" purpose="How terminals look, what the mouse does, and how tabs come back."
      sections={[
        { id: "look", title: "Look", kind: "normal", body: (
          <Section id="look" title="Look" preview={fontPreview}>
            <SettingRow kind="control" {...row("terminal.renderer")} control={seg<RendererPref>("Terminal renderer", c.renderer, [{ id: "auto", label: "Auto" }, { id: "gpu", label: "GPU" }, { id: "canvas", label: "Canvas" }, { id: "dom", label: "Compatibility" }], sv.renderer)} />
            <SettingRow kind="control" {...row("terminal.font")} control={<Select align="right" value={c.termFont} options={fonts} onChange={sv.font} />} />
            <SettingRow kind="control" {...row("terminal.fontSize")} control={stepper(`${c.termSize}px`, () => sv.size(Math.max(SIZE_MIN, c.termSize - 1)), () => sv.size(Math.min(SIZE_MAX, c.termSize + 1)), c.termSize > SIZE_MIN, c.termSize < SIZE_MAX, "font")} />
            <SettingRow kind="control" {...row("terminal.lineHeight")} control={stepper(c.termLine.toFixed(2).replace(/0$/, ""), () => sv.line(Math.max(LINE_HEIGHT_MIN, round(c.termLine - 0.05))), () => sv.line(Math.min(LINE_HEIGHT_MAX, round(c.termLine + 0.05))), c.termLine > LINE_HEIGHT_MIN, c.termLine < LINE_HEIGHT_MAX, "line height")} />
            <SettingRow kind="control" {...row("terminal.cursor")} control={seg<CursorStyle>("Cursor", c.termCursor, CURSORS.map((o) => ({ id: o.v, label: o.label })), sv.cursor)} />
            <SettingRow kind="control" {...row("terminal.paneBar")} control={seg("Pane bar", c.paneActs, [{ id: "edge", label: "Edge line" }, { id: "summary", label: "Summary" }, { id: "always", label: "Always open" }, { id: "off", label: "Off" }], sv.paneBar)} />
          </Section>) },
        { id: "mouse", title: "Mouse and clipboard", kind: "normal", body: (
          <Section id="mouse" title="Mouse and clipboard">
            <SettingRow kind="control" {...row("terminal.focusFollowsMouse")} control={sw("Focus follows mouse", c.ffm, sv.ffm)} />
            <SettingRow kind="control" {...row("terminal.copyOnSelect")} control={sw("Copy on select", c.copySel, sv.copy)} />
            <SettingRow kind="control" agentNever="a click then types the clipboard into a live shell: not something an agent switches on for the owner" {...row("terminal.rightClickPaste")} control={sw("Right-click to paste", c.rcPaste, sv.rc)} />
          </Section>) },
        { id: "tabs", title: "Tabs", kind: "normal", body: (
          <Section id="tabs" title="Tabs">
            <SettingRow kind="control" {...row("terminal.paneBarMarker")} control={<Select align="right" value={c.paneMark} onChange={(v) => sv.marker(v as PaneMarker)} options={[{ value: "line", label: "Line" }, { value: "arrow", label: "Arrow" }]} />} />
            <SettingRow kind="control" {...row("terminal.tabGroups")} control={sw("Group tabs by project", c.groupsOn, sv.groups)} />
            <SettingRow kind="control" {...row("terminal.tabGroupRules")} control={<ListEditor label="Group by name" value={c.groupRules} onSave={setRules} placeholder="agx=agentglass" />} />
          </Section>) },
        { id: "history", title: "History", kind: "normal", body: (
          <Section id="history" title="History">
            <SettingRow kind="control" {...row("terminal.scrollback")} control={<Select align="right" value={String(c.scrollback)} onChange={(v) => sv.scroll(Number(v))} options={SCROLLBACK_SIZES.map((n) => ({ value: String(n), label: n >= 1000 ? `${n / 1000}k lines` : `${n} lines` }))} />} />
            <SettingRow kind="control" {...row("terminal.wordSeparators")} control={<TextCommitField label="Word separators" mono value={c.wordSep} onSave={setWords} />} />
            <SettingRow kind="control" {...row("terminal.benchButton")} help={`${COPY["terminal.benchButton"].help} ${chordLabel(appChordFor("bench.toggle"))} always opens the bench.`} control={seg("Floating button", c.benchFab, [{ id: "always", label: "Always" }, { id: "open", label: "When open" }, { id: "never", label: "Never" }], sv.fab)} />
            <SettingRow kind="control" {...row("terminal.benchLinks")} control={sw("Open PR and card links on the bench", c.benchLnk, sv.benchLinks)} />
            <SettingRow kind="control" {...row("terminal.otherLinks")} control={<Select align="right" value={c.otherLnk} onChange={(v) => sv.other(v as OtherLinks)} options={OTHER_LINKS.map((o) => ({ value: o.v, label: o.label }))} />} />
            <SettingRow kind="control" {...row("terminal.noteEditor")} control={seg<NoteEditor>("Note editor", c.noteEd, NOTE_EDITORS.map((o) => ({ id: o.v, label: o.label })), sv.note)} />
          </Section>) },
        { id: "restore", title: "Restore after reboot", kind: "normal", body: (
          <Section id="restore" title="Restore after reboot">
            {down}
            {tmux && (<>
              <SettingRow kind="control" {...row("tmux.restore")} control={sw("Restore the layout", tmux.restoreEnabled, (v) => void saveEngine({ restore: v }, "Restore", { restore: !v }), busy)} />
              <SettingRow kind="control" {...row("tmux.resume")} control={<Select align="right" value={tmux.resumeMode} disabled={busy || !tmux.restoreEnabled} onChange={(v) => void saveEngine({ resume: v === "all" ? "all" : "lazy" }, "Resume mode", { resume: tmux.resumeMode === "all" ? "all" : "lazy" })} options={[{ value: "lazy", label: "Lazy resume" }, { value: "all", label: "Resume all" }]} />} />
              {tmux.crashLoop && <SettingRow kind="control" {...row("tmux.layoutSkipped")} control={<Button onClick={() => restoreAction("restore")} disabled={busy}>Restore now</Button>} />}
              <SettingRow kind="control" label={COPY["tmux.lastCapture"].label}
                help={tmux.lastCaptureAt ? `${COPY["tmux.lastCapture"].help} Saved ${minutesAgo(tmux.lastCaptureAt)}.` : "Nothing saved yet. Turn on restore and one is taken within a minute."}
                control={<span className="flex items-center gap-2">
                  <Button onClick={() => restoreAction("capture")} disabled={busy}>Capture now</Button>
                  {tmux.lastCaptureAt && <Button onClick={() => restoreAction("restore")} disabled={busy}>Restore now</Button>}
                  {tmux.lastCaptureAt && <Button onClick={() => restoreAction("clear")} disabled={busy}>Clear</Button>}
                </span>} />
            </>)}
            {note}
            <SettingRow kind="link" agentExempt label="More terminal engine settings" help="Live in Advanced, under Terminal engine." linkText="Open Advanced" onOpen={() => openSettings("advanced")} />
          </Section>) },
        { id: "danger", title: "Danger zone", kind: "danger", body: (
          <DangerZone>
            <SettingRow kind="control" {...row("tmux.reset")} control={<DangerAction label="Reset tmux to defaults" onConfirm={reset} />} />
          </DangerZone>) },
      ]} />
  );
}
