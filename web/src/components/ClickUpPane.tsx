import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { clickupPrefs, clickupPrefsSaved } from "../lib/clickupPrefs.ts";
import { __forgetClickupSetup, clickupSetup } from "../lib/clickupSetup.ts";
import { __forgetClickupSpaces, PENDING_CARDS, useClickupSpaces } from "../lib/clickupSpaces.ts";
import { __forgetClickupPrefs } from "../lib/clickupPrefs.ts";
import { CLICKUP, addTurnsWritesOn, clickupAdd, clickupBlocks, clickupRemove, clickupSteps, type PrefsPatch } from "../lib/clickupWorkflow.ts";
import { triggerOf } from "../lib/stepBlocksView.ts";
import { fieldIsWritable } from "../lib/stepExtras.ts";
import type { FieldChoice } from "./StepExtraRows.tsx";
import { allStatuses, isActive, moments, resolveImplicit, withCounted, type MapSpace, type StepKind } from "../lib/workflowMap.ts";
import { eyeIds, pageState, partitionUnits, type Partition } from "../lib/workflowLayout.ts";
import { openSettings } from "../lib/openSettings.ts";
import { __forgetListMembers } from "../lib/listMembers.ts";
import { setting } from "../lib/settingsRegistry.ts";
import { DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN, type ClickUpPrefs, type ClickUpStepBlock, type ProviderStatus } from "../../../shared/providers.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../../shared/cardSkills.ts";
import { SettingRow, Switch, Toggle } from "./SettingRow.tsx";
import { EmptyState, Field, SettingsCard, SettingsForm, StatusBadge, helpIdFor } from "./SettingsKit.tsx";
import { Button, INPUT, INPUT_STYLE, Segmented } from "./workspace/Chrome.tsx";
import { Dot, StatusPopover, type PanelView } from "./StatusPanel.tsx";
import { ListEye, WorkflowMap } from "./WorkflowMap.tsx";
import { WFM_CSS } from "./workflowMapStyle.ts";
import { Card, CountedPicker, CardView, PrView, TextRow, Tagged, ago, hint } from "./TrackerMapParts.tsx";
import { EyeIcon, LockIcon, PlusIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { HIT, ICON } from "../lib/iconSize.ts";
import { ColumnsIcon, PlugIcon, SearchIcon, SlidersIcon } from "./settingsNavIcons.tsx";

const n = CLICKUP.nouns;


/** Which agent skills count as knowing what a card is. It was filed under the tracker's names; it is about agents. */
export function CardSkillsRow({ connected }: { connected: boolean }) {
  const [prefs, setPrefs] = useState<ClickUpPrefs | null>(null);
  useEffect(() => { if (connected) void clickupPrefs().then((p) => setPrefs(p)); }, [connected]);
  if (!connected || !prefs) return null;
  return (
    <TextRow label="Card skills pattern" hint="Regex on a skill’s name or description: which skills know what a card is."
      value={prefs.cardSkillPattern} fallback={DEFAULT_CARD_SKILL_PATTERN} placeholder="clickup|\bcu-|-cu\b"
      onSave={async (v) => {
        const r = await api.clickupSetPrefs({ cardSkillPattern: v });
        if (!r.ok || !r.prefs) return r.error ?? "That did not save";
        setPrefs(r.prefs); clickupPrefsSaved(r.prefs); return null;
      }} />
  );
}



/** Sign in with a token: the page's face before ClickUp is connected, and after it refuses the one it has. */
export function ConnectCard({ refused, error, onDone }: { refused: boolean; error: string | null; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bad = refused || !!err;
  const go = async () => {
    if (!token.trim() || busy) return;
    setBusy(true); setErr(null);
    const r = await api.providerConnect("clickup", token.trim()).catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? `${n.name} refused this token`); return; }
    __forgetClickupSetup(); __forgetClickupPrefs(); __forgetClickupSpaces(); __forgetListMembers();
    onDone();
  };
  const reasons: [ReactNode, string, string][] = [
    [<EyeIcon size={ICON.md} />, "Reads first", `The ${n.lists} where your tasks live, their statuses and two fields. Nothing else leaves ${n.name}.`],
    [<LockIcon size={ICON.md} />, "Read-only until you say", "Changes are off by default, and each step acts only when its button is pressed."],
    [<PlusIcon size={ICON.md} />, "Your statuses, not ours", `A step moves a ${n.item} to one of your own statuses. None are assumed.`],
  ];
  /* The page's face before ClickUp is connected: one card, the verdict at its
     top right, one stacked field and one Connect, the refusal under it, and
     what connecting does as a list under that — one column, so it reads the
     same at the window's narrowest. */
  return (
    <SettingsCard title={n.name} icon={<PlugIcon size={ICON.sm} />} desc="Link it once and a pull request knows its card."
      status={<StatusBadge tone={refused ? "err" : "off"}>{refused ? "Token refused" : "Not connected"}</StatusBadge>}>
      <SettingRow agentExempt label="Connect with a token" hint={`${n.name} reads with a personal API token, kept on this machine.`}
        below={
          <SettingsForm label={`Connect ${n.name}`} onSubmit={() => void go()}>
            <Field label="Personal API token" htmlFor="cu-token"
              help={bad ? undefined : `${n.name} → avatar → Settings → Apps → API token.`}>
              <input id="cu-token" type="password" value={token} placeholder="pk_…" autoComplete="off" spellCheck={false}
                aria-invalid={bad} aria-describedby={bad ? "cu-token-h" : helpIdFor("cu-token")} onChange={(e) => setToken(e.target.value)}
                className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, ...(bad ? { borderColor: "var(--error)", background: "color-mix(in srgb, var(--error) 11%, var(--bg))" } : null) }} />
            </Field>
            <div className="agx-field">
              <div className="agx-sform-actions">
                <Button type="submit" tone="primary" size="regular" pending={busy} disabled={!token.trim()}>Connect</Button>
              </div>
              {bad && (
                <div id="cu-token-h" role="alert" className="flex gap-2 items-start text-[12px]" style={{ color: "var(--error-ink)" }}>
                  <span className="shrink-0 mt-0.5"><WarningIcon size={ICON.sm} /></span>
                  <span><b>{`${(err ?? error ?? `${n.name} no longer accepts this token`).replace(/[.\s]+$/, "")}.`}</b> {err ? "Copy it again whole, without blanks. Nothing was saved." : "Your steps are kept exactly as they are; they resume once you reconnect."}</span>
                </div>
              )}
            </div>
          </SettingsForm>
        } />
      <SettingRow agentExempt label="What connecting does" hint="Nothing changes in your workspace until you say so."
        below={
          <ul className="m-0 p-0 flex flex-col gap-3" style={{ listStyle: "none" }}>
            {reasons.map(([ic, t, d]) => (
              <li key={t} className="flex gap-3 items-start">
                <span aria-hidden className="grid place-items-center rounded-full shrink-0" style={{ width: HIT, height: HIT, background: "var(--surface-inset)", color: "var(--primary)" }}>{ic}</span>
                <span className="text-[13px]">{t}<span className="block text-[12px] mt-0.5" style={{ color: "var(--text3)" }}>{d}</span></span>
              </li>
            ))}
          </ul>
        } />
    </SettingsCard>
  );
}

/** The map before ClickUp is connected: there is nothing to draw yet, and Add is not offered. */
export function WaitingMap({ name = n.name }: { name?: string }) {
  return (
    <SettingsCard title="Workflow map" icon={<ColumnsIcon size={ICON.sm} />} desc="Each step puts one control into agentglass. You build what it does from blocks."
      actions={<Button tone="primary" disabled><PlusIcon size={ICON.xs} /> Add a step</Button>}>
      <EmptyState>{`Appears once ${name} is connected.`}</EmptyState>
    </SettingsCard>
  );
}

export function ClickUpPane() {
  const [prefs, setPrefs] = useState<ClickUpPrefs | null>(null);
  const [writes, setWrites] = useState<boolean | null>(null);
  const [prefix, setPrefix] = useState<string | undefined>(undefined);
  const [connected, setConnected] = useState(true);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [linked, setLinked] = useState(true);
  const [foundOpen, setFoundOpen] = useState<boolean | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [hover, setHover] = useState<StepKind | null>(null);
  const [countAt, setCountAt] = useState<HTMLElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const { state, reread } = useClickupSpaces();
  const advRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void clickupPrefs().then((p) => { if (live && p) setPrefs(p); });
    void clickupSetup().then((s) => { if (live) { setWrites(s.writeEnabled ?? false); setPrefix(s.prefix); setConnected(s.connected); } });
    void api.providers().then((r) => { if (live) setProvider(r.providers.find((x) => x.id === "clickup") ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [epoch]);

  const units: MapSpace[] = useMemo(() => {
    const raw = state.kind === "ok" ? state.spaces : state.kind === "error" || state.kind === "loading" ? state.stale ?? [] : [];
    return raw.map((s) => ({ id: s.id, name: s.name, ...(s.group ? { group: s.group } : null), statuses: s.statuses, ...(s.counted === false ? { counted: false } : null), ...(s.fromList ? { fromList: true } : null), ...(s.spaceId ? { spaceId: s.spaceId } : null), ...(s.cards ? { cards: s.cards } : null) }));
  }, [state]);
  const part = useMemo(() => partitionUnits(units), [units]);
  const panel: PanelView = state.kind === "ok" ? { kind: "ok" }
    : state.kind === "loading" ? { kind: "loading" }
    : state.kind === "empty" ? { kind: "empty" }
    : { kind: "error", text: state.throttled ? `${n.name} asked us to wait (rate limit).` : state.error };
  const frozen = state.kind === "error" && state.unauthorised === true;

  /* What each step points at, with the built-in default filled in for a step that names none:
     what the map shows has to be what the app runs. Memoised, so the map's lines are not redrawn
     for a render that changed nothing. */
  const steps = useMemo(() => (prefs ? resolveImplicit(CLICKUP, clickupSteps(prefs), allStatuses(part.counted)) : []), [prefs, part]);

  const send = useCallback(async (patch: PrefsPatch): Promise<boolean> => {
    const r = await api.clickupSetPrefs(patch);
    if (!r.ok || !r.prefs) { setNote(r.error ?? "That did not save"); return false; }
    setNote(null); setPrefs(r.prefs); clickupPrefsSaved(r.prefs);
    return true;
  }, []);
  /* The pick goes through its def, the one write path a row and an agent share. It saves through the same
     /clickup/prefs and re-answers from the spaces the server holds: no ClickUp request. An empty list is the default. */
  const count = useCallback((ids: string[]) => { setting("clickup.statusSpaces.counted").set(ids.join(",")); }, []);
  /* The custom fields of the lists this person works in (the saved boards' lists), for "Set a field": each list's own
     cached answer, so it costs the lists' reads and nothing new. Read-only fields and kinds this cannot write are left out. */
  const readFields = useCallback(async (): Promise<FieldChoice[] | null> => {
    const v = await api.clickupViews().catch(() => null);
    if (!v) return null;
    const ids = [...new Set((v.views ?? []).map((x) => x.listId).filter((x): x is string => !!x))].slice(0, 8);
    const out = new Map<string, FieldChoice>();
    for (const id of ids) {
      const r = await api.clickupList(id).catch(() => null);
      for (const f of r?.ok ? (r.fields ?? []) : []) {
        if (!fieldIsWritable(f)) continue;
        const key = f.name.trim().toLowerCase();
        const cur = out.get(key) ?? { name: f.name, type: f.type, options: [] as { id: string; name: string }[] };
        for (const o of f.options ?? []) if (!cur.options!.some((x) => x.name.toLowerCase() === o.name.toLowerCase())) cur.options!.push({ id: o.id, name: o.name });
        out.set(key, cur);
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  /* The workspace's people for "a person…", read when that list opens: the answer the member picker already holds. */
  const readPeople = useCallback(async () => {
    const r = await api.clickupMembers("", true).catch(() => null);
    return r?.ok ? (r.members ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.me ? { sub: "you" } : m.email ? { sub: m.email } : null) })) : null;
  }, []);
  const setChanges = useCallback(async (on: boolean) => {
    await api.clickupSetWrites(on).catch(() => null);
    __forgetClickupSetup();
    const s = await clickupSetup();
    setWrites(s.writeEnabled ?? on);
  }, []);

  if (!prefs) return <div className="py-6 text-[11px]" style={{ color: "var(--text3)" }}>Reading your settings…</div>;
  const changesOn = writes === true;
  const M = moments(n);
  const live = changesOn ? steps.filter((s) => isActive(s, M[s.kind])) : [];
  const distinct = allStatuses(part.counted).length;
  const asOf = state.kind === "ok" || state.kind === "empty" ? state.at : state.kind === "error" ? state.staleAt : undefined;
  const st = pageState({ connected, refused: frozen, writes: changesOn, steps, part, m: (s) => M[s.kind] });
  /* The eye on a list: the same save the checklist makes, through the setting. */
  const toggleCounted = (u: MapSpace) => { const ids = eyeIds(units, u); if (ids) count(ids); };
  const chosen = prefs.statusSpaces.counted.length > 0;
  const narrowed = state.kind === "ok" && !state.note;
  const showAdvanced = () => { setAdvOpen(true); requestAnimationFrame(() => advRef.current?.querySelector<HTMLElement>("input")?.focus()); };
  const source = <><b style={{ color: "var(--text)" }}>Where these come from.</b> {narrowed ? `The ${n.lists} where your tasks live` : `The ${n.spaces} ${n.name} returned`}{asOf ? `, read from ${n.name} ${ago(asOf)}` : ""}. {part.folded.length ? `The rest are folded below; ` : ""}choosing costs no request.</>;
  /* Cards still being read: which lists count is not known yet, and "0 lists count" or "none" would say it is. */
  const reading = state.kind === "loading" && state.why === PENDING_CARDS;
  const countWord = (c: Partition) => (reading ? "reading which ones your cards live in…" : c.counted.length ? c.counted.map((u) => u.name).join(", ") : "none");

  if (st === "out" || st === "refused") {
    return (
      <div className="wfm">
        <style>{WFM_CSS}</style>
        <ConnectCard refused={st === "refused"} error={state.kind === "error" ? state.error : null} onDone={() => { setEpoch((e) => e + 1); reread(); }} />
        <WaitingMap />
      </div>
    );
  }

  return (
    <div className="wfm">
      <style>{WFM_CSS}</style>
      {/* The connection, and the one switch that decides whether anything
          here can write. The switch is a row like any other: its state is a
          badge first in the control column, the switch after it, and the
          warning ink only while changes are on, because that is the state
          the person has to keep in mind. */}
      <SettingsCard title={n.name} icon={<PlugIcon size={ICON.sm} />} desc={provider?.detail ?? undefined}
        status={<StatusBadge tone="ok">Connected</StatusBadge>}
        actions={<Button onClick={() => openSettings("connections")}>Manage connection</Button>}>
        <SettingRow label={<span id="cu-changes-l">{`Changes in ${n.name}`}</span>}
          hint={changesOn ? `Only the steps below can change a ${n.item}, one at a time, when you press their button.` : steps.length ? "agentglass only reads. Turn this on to let the steps below act." : "agentglass only reads. Adding your first step turns this on."}
          status={<span data-guard={changesOn ? "on" : "off"}><StatusBadge tone={changesOn ? "warn" : "off"}>{changesOn ? "On" : "Read-only"}</StatusBadge></span>}
          control={<button type="button" role="switch" aria-checked={changesOn} aria-labelledby="cu-changes-l" disabled={writes === null}
            onClick={() => void setChanges(!changesOn)} className="agx-switch-hit inline-flex items-center rounded-full" style={{ minHeight: HIT }}><Switch on={changesOn} /></button>} />
      </SettingsCard>

      <Card id="cu-found" icon={<SearchIcon size={ICON.sm} />} title="What we found" open={foundOpen ?? steps.length === 0} onToggle={setFoundOpen}
        desc={reading ? undefined : `${part.counted.length} ${n.lists} count · ${distinct} statuses${part.folded.length ? ` · ${part.folded.length} ignored` : ""}${prefs.prLinkField ? ` · PR link ${prefs.prLinkField}` : ""}${prefs.swatchField ? ` · swatch ${prefs.swatchField}` : ""}`}
        status={<StatusBadge tone={state.kind === "error" ? "warn" : state.kind === "loading" ? "checking" : "ok"}>{reading ? "Reading your cards" : state.kind === "loading" ? "Reading" : state.kind === "error" ? (asOf ? `As of ${ago(asOf)}` : "Not read") : "Read-only"}</StatusBadge>}>
        <SettingRow label={`${n.lists[0]!.toUpperCase()}${n.lists.slice(1)} that count`}
          hint={<>{countWord(part)}<span className="block mt-1">{chosen ? "You chose these. The rest are ignored, not deleted." : state.kind === "ok" && state.note ? state.note : `Where your ${n.items} live, until you choose.`}</span></>}
          actions={<Button aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button>} />
        <SettingRow label={`Your ${n.lists} and their statuses`}
          below={state.kind === "loading" && !units.length ? hint("reading…")
            : part.counted.length ? (
              <ul className="m-0 p-0 flex flex-col gap-2" style={{ listStyle: "none" }}>
                {part.counted.map((u) => (
                  <li key={u.id} className="flex gap-2 items-start">
                    <span className="flex gap-2 items-center flex-wrap flex-1 min-w-0"><b>{u.name}</b>{hint(`${u.group ? `${u.group} · ` : ""}${u.statuses.length} statuses`)}
                      <span className="flex gap-1 flex-wrap">{u.statuses.map((s) => <Tagged key={s.status}><Dot type={s.type} color={s.color} />{s.status}</Tagged>)}</span></span>
                    <ListEye unit={u} nouns={n} onToggle={toggleCounted} blocked={frozen || eyeIds(units, u) === null} />
                  </li>
                ))}
              </ul>
            ) : hint(`No ${n.list} counts.`)} />
        <SettingRow agentExempt label="Not used by steps"
          hint={part.folded.length ? `${part.folded.length} ${chosen ? "ignored" : `other ${n.spaces}`} (${part.folded.map((f) => f.unit.name).join(", ")}). Their statuses stay out of the picker until you open them.` : "Nothing is folded away."} />
        <SettingRow agentExempt label="How we read it"
          hint={asOf && state.kind === "ok" ? `Read ${ago(asOf)} · cached for 10 min.` : "Nothing needs setting up."}
          actions={<Button onClick={reread} disabled={frozen || state.kind === "loading"}>Re-read</Button>}
          below={<div className="flex flex-col gap-2" style={{ maxWidth: 480 }}>
            <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Task ids {prefix ? <><Tagged>{prefix}n</Tagged>{hint("custom ids")}</> : hint("default; a custom prefix is read from the first board you open")}</div>
            <div className="flex gap-2 items-baseline flex-wrap text-[13px]">PR link {prefs.prLinkField ? <Tagged>{prefs.prLinkField}</Tagged> : hint("a field with “github” in its name")}</div>
            <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Swatch {prefs.swatchField ? <Tagged>{prefs.swatchField}</Tagged> : hint("guessed from the field names")}</div>
            <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Sprints {prefs.sprintListPattern === DEFAULT_SPRINT_LIST_PATTERN ? hint("lists named like “Sprint 12”, and dated ones") : <><Tagged>{prefs.sprintListPattern}</Tagged>{hint("and dated ones")}</>}</div>
            <span><button type="button" className="agx-textlink text-[12px]" onClick={showAdvanced}>Change these in Advanced</button></span>
          </div>} />
      </Card>
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker n={n} units={units} chosen={chosen} onChange={count} onReset={() => count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}

      <WorkflowMap adapter={CLICKUP} part={part} panel={panel} steps={steps} changesOn={changesOn} frozen={frozen} source={source}
        onHover={setHover}
        onAdd={async (kind) => {
          const ok = await send(clickupAdd(kind));
          if (ok && addTurnsWritesOn(changesOn, steps.length)) await setChanges(true);
          return ok;
        }}
        onBlocks={(kind, blocks) => { const t = triggerOf(kind); if (t) void send(clickupBlocks(t, blocks.filter((b): b is ClickUpStepBlock => b.type !== "link"))); }}
        onRemove={(kind) => { void send(clickupRemove(kind)); }}
        people={readPeople}
        fields={readFields}
        onToggleCounted={toggleCounted}
        onCountAgain={(u) => { const ids = withCounted(units, u.fromList && u.spaceId ? u.spaceId : u.id, true); if (ids) count(ids); }}
        onRetry={reread} />
      {note && <div role="alert" className="text-[12px] -mt-3 mb-6" style={{ color: "var(--error-ink)" }}>{note}</div>}

      <Card id="cu-shows" icon={<ColumnsIcon size={ICON.sm} />} title="Where this shows up" desc="Hover a step above to see which part of this it adds."
        actions={<Segmented label={`Does the pull request name a ${n.item}?`} value={linked ? "1" : "0"} onChange={(v) => setLinked(v === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} />}>
        <div className="grid gap-4 agx-settings-x pt-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div><PrView adapter={CLICKUP} status={CLICKUP.sample.status} steps={live} all={steps} writes={changesOn} hover={hover} linked={linked} /></div>
          <div><CardView adapter={CLICKUP} status={CLICKUP.sample.status} writes={changesOn} linked={linked} /></div>
        </div>
        <div className="agx-settings-x pt-3 pb-3 text-[12px]" style={{ color: "var(--text3)" }}>
          {live.length ? `Only the steps above show up. Everything else about a ${n.item} stays read-only.`
            : steps.length ? "Changes are off, so no step shows."
            : `No steps: the ${n.item} is shown, nothing writes.`}
          {!linked && ` This pull request names no ${n.item}: no ${n.name} block on it and no Pull requests section on the ${n.item}. Tasks works on its own.`}
        </div>
      </Card>

      <div ref={advRef}>
        <Card id="cu-adv" icon={<SlidersIcon size={ICON.sm} />} title="Advanced" desc="The fields and patterns the reading above is built on." open={advOpen} onToggle={setAdvOpen}>
          <TextRow label="PR link field" hint="The custom field that holds the pull request link. Empty: any field named github." value={prefs.prLinkField} placeholder="GitHub URL"
            onSave={async (v) => ((await send({ prLinkField: v } as never)) ? null : "That did not save")} />
          <TextRow label="Colour column field" hint="A drop-down shown as a swatch. Empty: guessed from the field names." value={prefs.swatchField} placeholder="Team"
            onSave={async (v) => ((await send({ swatchField: v } as never)) ? null : "That did not save")} />
          <TextRow label="Sprint list pattern" hint="Regex for sprint lists. Dated ones always count." value={prefs.sprintListPattern} fallback={DEFAULT_SPRINT_LIST_PATTERN} placeholder="^sprint\b"
            onSave={async (v) => patternSave(await api.clickupSetPrefs({ sprintListPattern: v }), setPrefs)} />
          <TextRow label="Read-only fields pattern" hint="Regex for fields shown but never written." value={prefs.readOnlyFieldPattern} fallback={DEFAULT_READ_ONLY_FIELD_PATTERN} placeholder="do not edit"
            onSave={async (v) => patternSave(await api.clickupSetPrefs({ readOnlyFieldPattern: v }), setPrefs)} />
          <Toggle on={prefs.assigned.includeSubtasks} onClick={() => { void send({ assigned: { includeSubtasks: !prefs.assigned.includeSubtasks } } as never); }}
            agentNever="changes how heavy the shared ClickUp read is against a rate-limited token the owner also works with, so it is the owner's to turn on" label="Subtasks on Assigned to me" hint="Slower: the workspace read can take twice as long." />
        </Card>
      </div>
    </div>
  );
}

function patternSave(r: { ok: boolean; error?: string; prefs?: ClickUpPrefs }, set: (p: ClickUpPrefs) => void): string | null {
  if (!r.ok || !r.prefs) return r.error ?? "That did not save";
  set(r.prefs); clickupPrefsSaved(r.prefs);
  return null;
}

