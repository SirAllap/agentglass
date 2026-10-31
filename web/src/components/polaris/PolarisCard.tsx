import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { Disclosure, ProblemNote, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { LockIcon, StarIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { askBuilderOnBench } from "../../lib/lanternAsk.ts";
import { api } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { ALSO_NEVER, GUARDRAILS, PRESETS, type PresetId, type SettingsAnswer, type SettingsChange, type StoredPolaris } from "../../../../shared/polaris.ts";
import {
  assistPrompt, assistState, changeDoor, formatBadge, formatNotice, groupDoors, groupViews, inheritAll, liveQuestion, pickPreset, presetChoices, presetQuestion, presetShown, resetDoors, scopeOf, stampFormat, storedOf, turnOn, undoStamp,
  type AssistState,
} from "../../lib/polarisView.ts";
import { usePolarisSettings } from "./usePolaris.ts";
import { DoorRow, LimitRow } from "./DoorRow.tsx";

/** The name of a group of doors, its one line, and the action that puts the group back. */
function GroupHead({ title, sub, note, action }: { title: string; sub: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="agx-settings-x pt-4 pb-1 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="m-0 text-[13px] font-semibold" style={{ color: "var(--text)" }}>{title}</h4>
        <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--text3)" }}>{sub}{note ? ` · ${note}` : ""}</p>
      </div>
      {action}
    </div>
  );
}

/** Opens a terminal with the engine set for the builder role and a prompt that reads and sets the doors through the settings door. */
function AssistedSetup({ root }: { root: string }) {
  const [state, setState] = useState<AssistState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.workerRoles().then((r) => { if (live) setState(assistState(r)); }).catch(() => { if (live) setState({ ok: false, why: "Could not read which engine is set." }); });
    return () => { live = false; };
  }, []);
  const go = async () => {
    if (!root) return;
    setBusy(true); setNote("");
    const r = await askBuilderOnBench(root, assistPrompt(root), "polaris setup");
    setBusy(false);
    if (!r.ok) setNote(r.error ?? "Could not open a terminal.");
  };
  // A project is needed: the terminal opens in it, and the doors it sets are that project's.
  const noProject = !root;
  const ready = state?.ok === true;
  return (
    <SettingRow label="Assisted setup" wide
      hint={ready ? `Opens a terminal with ${state.title}. It asks about your team, then sets the doors you agree to, one group at a time.` : state ? state.why : "Checking which engine is set."}
      control={
        <span className="inline-flex items-center gap-2">
          {state && !state.ok && <Button onClick={() => openSettings("engines")}>See Agent engines</Button>}
          <Button tone="primary" pending={busy} disabled={!ready || noProject || busy} title={noProject ? "Pick a project first: the terminal opens in it." : undefined} onClick={() => void go()}>Assisted setup</Button>
        </span>
      }
      below={note ? <p role="alert" className="m-0 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</p> : undefined} />
  );
}

const EXAMPLE_STEPS: [string, string][] = [
  ["14:00", "#322 “Add retry to the webhook sender” opens. Polaris reads it and files it In orbit: checks are running."],
  ["14:02", "Checks turn green and two people approved. It is now Cleared to land, with an Open on GitHub button."],
  ["14:03", "A conflict appears on #318. Polaris drafts a beacon for the session that owns it and waits."],
  ["14:05", "You press Send. The beacon goes once, to that session, when it is idle."],
  ["14:21", "#325 had a job dropped by its runner. In a dry run Polaris only says it would run it again."],
];

/** Two short explanations the Off card links to, opened in place: a worked example, and where the name comes from. */
function OffLinks() {
  return (
    <div className="grid gap-2">
      <Disclosure summary="See an example, step by step">
        <ol className="m-0 pl-4 text-[12px] grid gap-1" style={{ color: "var(--text2)" }}>{EXAMPLE_STEPS.map(([t, w]) => <li key={t}><b>{t}</b> {w}</li>)}</ol>
      </Disclosure>
      <Disclosure summary="What does Polaris stand for?">
        <p className="m-0 text-[12px]" style={{ color: "var(--text2)" }}>Polaris is the fixed star you steer by. Here it is the one place that tells you which pull request needs you and which can wait.</p>
      </Disclosure>
    </div>
  );
}

/** What changed in the settings format, with its example, a Dismiss that saves the layer in the new format, and the Undo that follows it. */
function FormatBanner({ answer, scope, busy, apply }: { answer: SettingsAnswer; scope: "project" | "global"; busy: boolean; apply: (c: SettingsChange) => Promise<void> }) {
  const [before, setBefore] = useState<StoredPolaris | null>(null);
  const [open, setOpen] = useState(false);
  const notice = formatNotice(answer, scope);
  useEffect(() => { setBefore(null); setOpen(false); }, [scope, answer.root]);
  if (before) {
    return (
      <SettingRow label={`Saved in format ${answer.version}`} hint="Your doors are as they were."
        control={<Button disabled={busy} onClick={() => { const b = before; setBefore(null); void apply(undoStamp(b)); }}>Undo</Button>} />
    );
  }
  if (!notice) return null;
  return (
    <SettingRow label={`Format ${notice.from} to ${notice.to}`} hint={notice.sentence}
      control={<span className="inline-flex items-center gap-2">
        <Button disabled={busy} onClick={() => setOpen(!open)}>See an example</Button>
        <Button tone="primary" disabled={busy} onClick={() => { setBefore(storedOf(answer, scope)); void apply(stampFormat(answer, scope)); }}>Dismiss</Button>
      </span>}
      below={open ? <p className="m-0 text-[12px]" style={{ color: "var(--text2)" }}>Example: {notice.example}</p> : undefined} />
  );
}

/**
 * The Polaris card of Settings > Orchestration. It follows the page's scope bar: a project
 * edits that project's own layer (and says where each door comes from), Global and All
 * projects edit the global layer. Off first; the doors by group; the guardrails locked.
 */
export function PolarisCard({ root }: { root: string }) {
  const scope = scopeOf(root);
  const { answer, error, busy, save, reload } = usePolarisSettings(root);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<{ question: string; change: SettingsChange } | null>(null);
  useEffect(() => { setNote(""); setAsking(null); }, [root]);

  const apply = async (change: SettingsChange) => { setAsking(null); setNote((await save(change)) ?? ""); };
  /** A change that puts a door live asks first; the way back never does. */
  const ask = (question: string | null, change: SettingsChange) => (question ? setAsking({ question, change }) : void apply(change));

  if (!answer) {
    return (
      <SettingsCard title="Polaris" icon={<StarIcon size={ICON.sm} />}>
        {error
          ? <ProblemNote title="Polaris did not load" action={<Button onClick={reload}>Retry</Button>}>{error}</ProblemNote>
          : <div className="agx-skel rounded-lg m-4" style={{ height: 96 }} aria-busy="true" aria-label="Loading" />}
      </SettingsCard>
    );
  }

  const where = scope === "project" ? "this project" : "all projects";
  const inheritsOn = scope === "project" && answer.enabledLayer !== "project";

  if (!answer.enabled) {
    return (
      <SettingsCard title="Polaris" icon={<StarIcon size={ICON.sm} />} status={<StatusBadge tone="off">Off</StatusBadge>}
        actions={<Button tone="primary" pending={busy} disabled={busy} onClick={() => void apply(turnOn(true))}>Turn on</Button>}>
        <SettingRow label="Polaris is off"
          hint={<>Polaris lets your orchestrator keep an eye on your pull requests. It tells you which ones are ready to land, which wait for a person and which are stuck, and says what to do next in one plain sentence. You decide, one door at a time, what it may do on its own. It never merges, and nothing leaves agentglass without your click. Turning it on for {where} starts in <b>Guided</b>: it reads and drafts, and anything it would run again is shown as a dry run first.{inheritsOn ? " This project follows the global setting until you turn it on here." : ""}</>} />
        <SettingRow label="How it works" hint="Two short reads before you turn it on." below={<OffLinks />} />
        <AssistedSetup root={root} />
        {note && <ProblemNote title="Polaris did not change">{note}</ProblemNote>}
      </SettingsCard>
    );
  }

  const groups = groupViews(answer, scope);
  const own = scope === "project" && (answer.enabledLayer === "project" || Object.values(answer.layers).includes("project"));
  const shown = presetShown(answer);
  return (
    <SettingsCard title="Polaris" icon={<StarIcon size={ICON.sm} />}
      desc="Each door is a permission: yes or no, and how. Pick a preset, then change any door."
      status={<span className="inline-flex items-center gap-2"><StatusBadge tone="ok">{inheritsOn ? "On, from global" : "On"}</StatusBadge><StatusBadge tone="info">{formatBadge(answer)}</StatusBadge></span>}
      actions={<Button disabled={busy} onClick={() => void apply(turnOn(false))}>Turn off</Button>}>
      <SettingRow label="Preset" hint="A preset sets all 17 doors of this layer at once. Moving any door afterwards reads Custom."
        control={<Segmented track label="Preset" value={shown ?? undefined} disabled={busy}
          options={presetChoices().map((p) => ({ id: p.id, label: p.label, title: p.id === "custom" ? "Shown when you move a door after picking a preset" : PRESETS[p.id].label }))}
          onChange={(id) => { if (id !== "custom") ask(presetQuestion(answer, id as PresetId), pickPreset(id as PresetId)); }} />} />
      {asking && (
        <SettingRow label="Put it live?" hint={asking.question}
          control={<span className="inline-flex items-center gap-2">
            <Button tone="primary" disabled={busy} onClick={() => void apply(asking.change)}>Go live</Button>
            <Button disabled={busy} onClick={() => setAsking(null)}>Stay as it is</Button>
          </span>} />
      )}
      {scope === "project" && (
        <SettingRow label="This project's own settings"
          hint={own ? "Some doors are set for this project. The rest follow the global settings." : "Every door follows the global settings. Changing one here gives this project its own."}
          control={<Button disabled={!own || busy} onClick={() => void apply(inheritAll())}>Use global for all</Button>} />
      )}
      {note && <ProblemNote title="Polaris did not change">{note}</ProblemNote>}
      <FormatBanner answer={answer} scope={scope} busy={busy} apply={apply} />

      {groups.map((g) => (
        <div key={g.id} data-polaris-group={g.id}>
          <GroupHead title={g.id} sub={g.sub} note={g.newCount ? `${g.newCount} new` : undefined}
            action={<Button size="compact" disabled={busy} onClick={() => void apply(resetDoors(answer, scope, groupDoors(g.id)))}>{g.resetLabel}</Button>} />
          {g.doors.map((v) => (
            <DoorRow key={v.door} v={v} disabled={busy}
              onMode={(mode) => ask(liveQuestion(v.door, v.value, { ...v.value, mode }), changeDoor(answer, scope, v.door, { mode }))}
              onParams={(patch) => ask(liveQuestion(v.door, v.value, { ...v.value, ...patch }), changeDoor(answer, scope, v.door, patch))}
              onReset={scope === "project" && v.layer === "project" ? () => void apply(resetDoors(answer, scope, [v.door])) : undefined} />
          ))}
          {g.limits.map((l) => (
            <LimitRow key={l.door} v={l} disabled={busy}
              onChange={(n) => ask(liveQuestion(l.door, answer.doors[l.door], { ...answer.doors[l.door], [l.param]: n }), changeDoor(answer, scope, l.door, { [l.param]: n }))} />
          ))}
        </div>
      ))}

      <GroupHead title="Guardrails" sub="Locked in every preset" />
      {GUARDRAILS.map((g) => (
        <SettingRow key={g.title} label={<span className="inline-flex items-center gap-2"><LockIcon size={ICON.sm} />{g.title}</span>} hint={g.detail}
          control={<StatusBadge tone="ok">Always</StatusBadge>} />
      ))}
      <SettingRow label="Also never" hint="Eight more things Polaris does not do, in any preset."
        below={<Disclosure summary={`The eight (${ALSO_NEVER.length})`}><ul className="m-0 pl-4 text-[12px]" style={{ color: "var(--text2)" }}>{ALSO_NEVER.map((l) => <li key={l}>{l}</li>)}</ul></Disclosure>} />

      <AssistedSetup root={root} />
    </SettingsCard>
  );
}
