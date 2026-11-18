// Shortcuts on the new Settings shell: Views, Actions, Even inside a shell.
// One row per key binding, each with its keycaps as the control. Recording a key
// is the same capture the modal always ran; its state comes in as `c`.
import { useState, type ReactNode } from "react";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { SaveToastHost, DangerAction } from "../save/index.ts";
import { KeyCaps, RebindButton } from "../../SettingsModal.tsx";
import { DEFAULTS, chordFor, keyRowName, chordLabel, hasCustomChord, clearChord, bindings, LABELS, APP_CHORD_DEFAULTS, APP_CHORD_LABELS, appChordFor, hasCustomAppChord, resetBindings, resetChords, resetAppChords, type ActionId, type AppChordId } from "../../../lib/keybindings.ts";
import type { ViewId } from "../../workspace/views.ts";
import { MOD_KEY } from "../../../lib/format.ts";
import { ACTIONS_INTRO, SHELL_INTRO, SHORTCUTS_PURPOSE, SHORTCUTS_SECTIONS } from "./shortcutsModel.ts";
import type { PageCtx } from "./ctx.ts";

const help = (section: string, label: string) =>
  SHORTCUTS_SECTIONS.find((s) => s.id === section)!.rows.find((r) => r.label === label)!.help;

export function ShortcutsPage({ c }: { c: PageCtx }) {
  const { appKeyError, capturing, capturingApp, capturingChord, keyError, keys, setAppKeyError, setCapturing, setCapturingApp, setCapturingChord, setKeyError, setKeys } = c;
  const [why, setWhy] = useState(false);
  const ids = Object.keys(DEFAULTS) as ActionId[];
  const viewIds = ids.filter((id) => id.startsWith("view.")) as `view.${ViewId}`[];
  const rest = ids.filter((id) => !id.startsWith("view."));
  const stop = () => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp(null); };
  const cap = (n: string | undefined) => (n === " " ? "space" : n ?? "—");
  const errOf = (id: string) => (keyError?.id === id ? keyError.msg : null);

  const sections: PageSection[] = [
    { id: "views", title: "Views", kind: "normal", body: (
      <Section id="views" title="Views" intro="Click a key to record another.">
        {viewIds.map((id) => {
          const view = id.slice(5) as ViewId;
          const chord = chordFor(view);
          const capC = capturingChord === view;
          const capK = capturing === id;
          return (
            <SettingRow key={id} kind="control" settingId={`keys.binding.${id}`} label={keyRowName(id)}
              help={errOf(id) ?? undefined}
              control={<span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <KeyCaps text={capC ? "Hold a combo…" : chord ? chordLabel(chord) : "—"} active={capC} custom={hasCustomChord(view)} faint={!chord && !capC}
                    onClick={() => { stop(); setCapturingChord((x) => (x === view ? null : view)); }} />
                  {hasCustomChord(view) && !capC && (
                    <button type="button" className="text-[11px] underline" style={{ color: "var(--accent)" }} aria-label={`Back to the rail position for ${keyRowName(id)}`}
                      onClick={() => { clearChord(view); setKeys({ ...bindings() }); }}>Reset</button>
                  )}
                </span>
                <KeyCaps text={capK ? "Press a key…" : cap(keys[id])} active={capK}
                  onClick={() => { setKeyError(null); setCapturingChord(null); setCapturingApp(null); setCapturing((x) => (x === id ? null : id)); }} />
              </span>} />
          );
        })}
        <SettingRow kind="control" agentExempt label="Why some views have two keys" help={help("views", "Why some views have two keys")}
          control={<button type="button" className="text-[12px] underline" style={{ color: "var(--accent)" }} aria-expanded={why} onClick={() => setWhy((w) => !w)}>{why ? "Hide" : "Show"}</button>} />
        {why && (
          <div className="px-3 pb-3 text-[12px]" style={{ color: "var(--text2)" }}>
            <p className="m-0 mb-2"><b style={{ color: "var(--text)" }}>Chord</b>: hold any combination ({MOD_KEY}J, {MOD_KEY}Alt+J) and it is recorded as held. Left alone it follows the view's place on the rail.</p>
            <p className="m-0"><b style={{ color: "var(--text)" }}>Single key</b>: works only on Starboard, because inside the workspace every keystroke belongs to the shell.</p>
          </div>
        )}
      </Section>
    ) },
    { id: "actions", title: "Actions", kind: "normal", body: (
      <Section id="actions" title="Actions" intro={ACTIONS_INTRO}>
        {rest.map((id) => {
          const on = capturing === id;
          return (
            <SettingRow key={id} kind="control" settingId={`keys.binding.${id}`} label={keyRowName(id)} help={errOf(id) ?? LABELS[id].hint}
              control={<KeyCaps text={on ? "Press a key…" : cap(keys[id])} active={on}
                onClick={() => { setKeyError(null); setCapturingChord(null); setCapturingApp(null); setCapturing((x) => (x === id ? null : id)); }} />} />
          );
        })}
      </Section>
    ) },
    { id: "shell", title: "Even inside a shell", kind: "normal", body: (
      <Section id="shell" title="Even inside a shell" intro={`${SHELL_INTRO} ${chordLabel(APP_CHORD_DEFAULTS["files.palette"])} is free in bash, tmux and vim.`}>
        {(Object.keys(APP_CHORD_LABELS) as AppChordId[]).map((id) => {
          const on = capturingApp === id;
          const begin = () => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp((x) => (x === id ? null : id)); };
          const err = appKeyError?.id === id ? appKeyError.msg : null;
          return (
            <SettingRow key={id} kind="control" agentExempt label={APP_CHORD_LABELS[id].label} help={err ?? APP_CHORD_LABELS[id].hint}
              control={<span className="flex items-center gap-1.5">
                <KeyCaps text={on ? "Hold a combo…" : chordLabel(appChordFor(id))} active={on} custom={hasCustomAppChord(id)} onClick={begin} />
                <RebindButton capturing={on} what={APP_CHORD_LABELS[id].label} onClick={begin} />
              </span>} />
          );
        })}
      </Section>
    ) },
    { id: "danger", title: "Danger zone", kind: "danger", body: (
      <DangerZone>
        <SettingRow kind="control" agentExempt label="Reset to defaults" help={help("danger", "Reset to defaults")}
          control={<DangerAction label="Reset to defaults" onConfirm={() => { resetBindings(); resetChords(); resetAppChords(); setKeyError(null); setAppKeyError(null); stop(); }} />} />
      </DangerZone>
    ) },
  ];
  return (
    <>
      <SettingsPage title="Shortcuts" purpose={SHORTCUTS_PURPOSE} sections={sections} />
      <SaveToastHost />
    </>
  );
}
