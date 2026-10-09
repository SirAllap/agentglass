import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { clickupPrefs, clickupPrefsSaved } from "../lib/clickupPrefs.ts";
import { __forgetClickupSetup, clickupSetup } from "../lib/clickupSetup.ts";
import { useClickupSpaces } from "../lib/clickupSpaces.ts";
import { CLICKUP, addTurnsWritesOn, clickupAdd, clickupRemove, clickupSetStatus, clickupSteps, clickupUnassign, type PrefsPatch } from "../lib/clickupWorkflow.ts";
import { allStatuses, isActive, moments, resolveImplicit, type MapSpace } from "../lib/workflowMap.ts";
import { openSettings } from "../lib/openSettings.ts";
import { DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN, type ClickUpPrefs, type ProviderStatus } from "../../../shared/providers.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../../shared/cardSkills.ts";
import { SettingRow, Switch, Toggle } from "./SettingRow.tsx";
import { Button, EDGE, INPUT, INPUT_STYLE, LINE, Segmented, tintEdge } from "./workspace/Chrome.tsx";
import { Dot, type PanelView } from "./StatusPanel.tsx";
import { Tag, WorkflowMap } from "./WorkflowMap.tsx";
import { CaretIcon, DoneIcon, LinkIcon, NoteIcon, UserIcon } from "../lib/glyphIcons.tsx";
import { HIT, ICON } from "../lib/iconSize.ts";

const n = CLICKUP.nouns;

/** One name-or-pattern row. A value equal to the shipped one shows as empty, so the placeholder says what applies. */
function TextRow({ label, hint, value, fallback = "", placeholder, onSave, id }: {
  label: string; hint: ReactNode; value: string; fallback?: string; placeholder: string; id?: string;
  onSave: (v: string) => Promise<string | null>;
}) {
  const saved = value === fallback ? "" : value;
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const commit = async () => {
    if (draft === null) return;
    if (draft.trim() === saved) { setDraft(null); setErr(null); return; }
    const e = await onSave(draft);
    setErr(e);
    if (!e) setDraft(null);
  };
  return (
    <SettingRow label={label} hint={<>{hint}{err && <span className="block mt-1" style={{ color: "var(--error-ink)" }}>{err}</span>}</>}
      control={
        <input id={id} value={draft ?? saved} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off"
          className={`w-[220px] ${INPUT}`} style={INPUT_STYLE} />
      } />
  );
}

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

function Card({ id, title, right, children, open, onToggle }: { id: string; title: string; right?: ReactNode; children: ReactNode; open?: boolean; onToggle?: (o: boolean) => void }) {
  const head = (
    <>
      <div className="agx-settings-head-t">{title}</div>
      {right}
    </>
  );
  return (
    <section className="agx-settings-section" aria-labelledby={id}>
      {onToggle ? (
        <details open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
          <summary className="agx-settings-head agx-fold flex items-center gap-2.5 list-none" id={id}>
            <span aria-hidden className="flex transition-transform" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", color: "var(--text3)" }}><CaretIcon size={ICON.sm} /></span>
            {head}
          </summary>
          <div className="agx-settings-rows">{children}</div>
        </details>
      ) : (
        <>
          <div className="agx-settings-head flex items-center gap-2.5 flex-wrap" id={id}>{head}</div>
          <div className="agx-settings-rows">{children}</div>
        </>
      )}
    </section>
  );
}

function Kv({ k, v, change }: { k: string; v: ReactNode; change?: () => void }) {
  return (
    <div className="grid items-center gap-x-3.5 agx-settings-x py-2 text-[12.5px]" style={{ gridTemplateColumns: "170px minmax(0,1fr) auto" }}>
      <span className="text-[12px]" style={{ color: "var(--text3)" }}>{k}</span>
      <span className="min-w-0" style={{ color: "var(--text)" }}>{v}</span>
      {change ? <Button size="compact" onClick={change}>Change</Button> : <span />}
    </div>
  );
}

const ago = (at: number): string => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function ClickUpPane() {
  const [prefs, setPrefs] = useState<ClickUpPrefs | null>(null);
  const [writes, setWrites] = useState<boolean | null>(null);
  const [prefix, setPrefix] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [linked, setLinked] = useState(true);
  const [foundOpen, setFoundOpen] = useState<boolean | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const { state, reread } = useClickupSpaces();
  const advRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void clickupPrefs().then((p) => { if (live && p) setPrefs(p); });
    void clickupSetup().then((s) => { if (live) { setWrites(s.writeEnabled ?? false); setPrefix(s.prefix); } });
    void api.providers().then((r) => { if (live) setProvider(r.providers.find((x) => x.id === "clickup") ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const spaces: MapSpace[] = useMemo(() => {
    const raw = state.kind === "ok" ? state.spaces : state.kind === "error" || state.kind === "loading" ? state.stale ?? [] : [];
    return raw.map((s) => ({ id: s.id, name: s.name, statuses: s.statuses }));
  }, [state]);
  const panel: PanelView = state.kind === "ok" ? { kind: "ok" }
    : state.kind === "loading" ? { kind: "loading" }
    : state.kind === "empty" ? { kind: "empty" }
    : { kind: "error", text: state.throttled ? `${n.name} asked us to wait (rate limit).` : state.error };
  const frozen = state.kind === "error" && state.unauthorised === true;

  /* What each step points at, with the built-in default filled in for a step that names none:
     what the map shows has to be what the app runs. Memoised, so the map's lines are not redrawn
     for a render that changed nothing. */
  const steps = useMemo(() => (prefs ? resolveImplicit(CLICKUP, clickupSteps(prefs), allStatuses(spaces)) : []), [prefs, spaces]);

  const send = useCallback(async (patch: PrefsPatch): Promise<boolean> => {
    const r = await api.clickupSetPrefs(patch);
    if (!r.ok || !r.prefs) { setNote(r.error ?? "That did not save"); return false; }
    setNote(null); setPrefs(r.prefs); clickupPrefsSaved(r.prefs);
    return true;
  }, []);
  const setChanges = useCallback(async (on: boolean) => {
    await api.clickupSetWrites(on).catch(() => null);
    __forgetClickupSetup();
    const s = await clickupSetup();
    setWrites(s.writeEnabled ?? on);
  }, []);

  if (!prefs) return <div className="py-6 text-[12px]" style={{ color: "var(--text3)" }}>Reading your settings…</div>;
  const changesOn = writes === true;
  const M = moments(n);
  const live = changesOn ? steps.filter((s) => isActive(s, M[s.kind])) : [];
  const distinct = allStatuses(spaces).length;
  const asOf = state.kind === "ok" || state.kind === "empty" ? state.at : state.kind === "error" ? state.staleAt : undefined;

  const showAdvanced = () => { setAdvOpen(true); requestAnimationFrame(() => advRef.current?.querySelector<HTMLElement>("input")?.focus()); };

  return (
    <div className="flex flex-col">
      {state.kind === "error" && state.unauthorised && (
        <div role="alert" className="rounded-xl px-4 py-3 mb-3.5 flex gap-3 items-start" style={{ border: tintEdge("var(--error)", 45), background: "color-mix(in srgb, var(--error) 10%, transparent)" }}>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[13px]" style={{ color: "var(--error-ink)" }}>{n.name} no longer accepts this token (it was revoked or expired).</div>
            <div className="mt-1 text-[12px]" style={{ color: "var(--text3)" }}>Nothing is being read or written. Your steps are kept exactly as they are; they resume once you reconnect.</div>
            <div className="mt-2.5"><Button tone="primary" onClick={() => openSettings("connections")}>Reconnect in Tools &amp; services</Button></div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-1.5 text-[12.5px]" style={{ color: "var(--text3)" }}>
        <Tag tone={frozen ? "warn" : "ok"}>{frozen ? "Token refused" : "Connected"}</Tag>
        {provider?.detail && <span>{provider.detail}</span>}
        <Button size="compact" onClick={() => openSettings("connections")}>Manage connection</Button>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-2 text-[12px]">
          <span id="cu-changes-l" style={{ color: "var(--text)" }}>Changes in {n.name}</span>
          <button type="button" role="switch" aria-checked={changesOn} aria-labelledby="cu-changes-l" disabled={frozen || writes === null}
            onClick={() => void setChanges(!changesOn)} className="agx-switch-hit inline-flex items-center rounded-full" style={{ opacity: frozen ? 0.45 : 1, minHeight: HIT }}>
            <Switch on={changesOn} />
          </button>
          <b className="font-semibold min-w-[22px]" style={{ color: "var(--text)" }}>{changesOn ? "On" : "Off"}</b>
        </span>
      </div>
      <p className="m-0 mb-3.5 text-right text-[11.5px]" style={{ color: "var(--text3)" }}>
        {changesOn
          ? `Only the steps below can change anything, one ${n.item} at a time, when you press their button.`
          : steps.length ? "Off: agentglass only reads. Your steps stay listed and do nothing." : "Off: agentglass only reads. Adding your first step turns this on."}
      </p>

      <Card id="cu-found" title="What we found" open={foundOpen ?? steps.length === 0} onToggle={setFoundOpen}
        right={<>
          <Tag tone={state.kind === "loading" ? "dim" : state.kind === "error" ? "warn" : "ok"}>{state.kind === "loading" ? "reading…" : state.kind === "error" ? (asOf ? `as of ${ago(asOf)}` : "not read") : "read-only"}</Tag>
          <span className="flex-1" />
          <span className="text-[11.5px] font-normal" style={{ color: "var(--text3)" }}>{asOf && state.kind === "ok" ? `read ${ago(asOf)} · cached 10 min` : ""}</span>
        </>}>
        <Kv k="Spaces" v={state.kind === "loading" && !spaces.length ? <span style={{ color: "var(--text3)" }}>reading…</span>
          : spaces.length ? `${spaces.length}: ${spaces.slice(0, 4).map((s) => s.name).join(", ")}${spaces.length > 4 ? ` and ${spaces.length - 4} more` : ""}` : "none we can read"} />
        <Kv k="Statuses" v={spaces.length ? `${distinct} distinct, across ${spaces.length} ${n.spaces} with their own sets` : "—"} />
        <Kv k="Task ids" v={prefix ? <>custom ids, like <span className="chip">{prefix}n</span></> : "default ids; a custom prefix is read from the first board you open"} />
        <Kv k="Pull request link" v={prefs.prLinkField ? <>field <span className="chip">{prefs.prLinkField}</span></> : "a field with “github” in its name, when a list has one"} change={showAdvanced} />
        <Kv k="Colour swatch" v={prefs.swatchField ? <>field <span className="chip">{prefs.swatchField}</span></> : "guessed from the field names"} change={showAdvanced} />
        <Kv k="Sprints" v={prefs.sprintListPattern === DEFAULT_SPRINT_LIST_PATTERN ? <>lists named like “Sprint 12”, and dated ones</> : <>lists matching <span className="chip">{prefs.sprintListPattern}</span>, and dated ones</>} change={showAdvanced} />
        <div className="agx-settings-x py-2 text-[11px] flex items-center gap-2 flex-wrap" style={{ color: "var(--text3)" }}>
          <span>Nothing here needs setting up. The one call that read it: GET {n.spaces} (statuses included), cached 10 min.</span>
          <Button size="compact" onClick={reread} disabled={frozen || state.kind === "loading"}>Re-read</Button>
        </div>
      </Card>

      <WorkflowMap adapter={CLICKUP} spaces={spaces} panel={panel} steps={steps} changesOn={changesOn} frozen={frozen}
        onAdd={async (kind, status) => {
          const ok = await send(clickupAdd(kind, status));
          if (ok && addTurnsWritesOn(changesOn, steps.length)) await setChanges(true);
          return ok;
        }}
        onStatus={(kind, status) => { void send(clickupSetStatus(kind, status)); }}
        onRemove={(kind) => { void send(clickupRemove(kind)); }}
        onUnassign={(v) => { void send(clickupUnassign(v)); }}
        onRetry={reread} />
      {note && <div role="alert" className="text-[11.5px] -mt-2 mb-3" style={{ color: "var(--error-ink)" }}>{note}</div>}

      <Card id="cu-shows" title="Where this shows up"
        right={<><span className="flex-1" /><Segmented label={`Does the pull request name a ${n.item}?`} value={linked ? "1" : "0"} onChange={(v) => setLinked(v === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} /></>}>
        <div className="grid gap-4 agx-settings-x py-3.5" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <div><h3 className="m-0 mb-2 text-[12px] font-semibold">Pull request</h3><PrView steps={live} linked={linked} /></div>
          <div><h3 className="m-0 mb-2 text-[12px] font-semibold">Card</h3><CardView writes={changesOn} linked={linked} /></div>
        </div>
        <div className="agx-settings-x py-2 text-[11px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
          {live.length ? "Only the steps above show up. Everything else is read-only."
            : steps.length ? "Changes are off, so no step shows."
            : `No steps: the ${n.item} is shown, nothing writes.`}
          {!linked && ` This pull request names no ${n.item}: no ${n.name} block on it and no Pull requests section on the ${n.item}. Tasks works on its own.`}
        </div>
      </Card>

      <div ref={advRef}>
        <Card id="cu-adv" title="Advanced" open={advOpen} onToggle={setAdvOpen}>
          <TextRow label="PR link field" hint="The custom field that holds the pull request link. Empty: any field named github." value={prefs.prLinkField} placeholder="GitHub URL"
            onSave={async (v) => ((await send({ prLinkField: v } as never)) ? null : "That did not save")} />
          <TextRow label="Colour column field" hint="A drop-down shown as a swatch. Empty: guessed from the field names." value={prefs.swatchField} placeholder="Team"
            onSave={async (v) => ((await send({ swatchField: v } as never)) ? null : "That did not save")} />
          <TextRow label="Sprint list pattern" hint="Regex for sprint lists. Dated ones always count." value={prefs.sprintListPattern} fallback={DEFAULT_SPRINT_LIST_PATTERN} placeholder="^sprint\b"
            onSave={async (v) => patternSave(await api.clickupSetPrefs({ sprintListPattern: v }), setPrefs)} />
          <TextRow label="Read-only fields pattern" hint="Regex for fields shown but never written." value={prefs.readOnlyFieldPattern} fallback={DEFAULT_READ_ONLY_FIELD_PATTERN} placeholder="do not edit"
            onSave={async (v) => patternSave(await api.clickupSetPrefs({ readOnlyFieldPattern: v }), setPrefs)} />
          <Toggle on={prefs.assigned.includeSubtasks} onClick={() => { void send({ assigned: { includeSubtasks: !prefs.assigned.includeSubtasks } } as never); }}
            label="Subtasks on Assigned to me" hint="Slower: the workspace read can take twice as long." />
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

const sm = CLICKUP.sample;
function Mini({ children }: { children: ReactNode }) {
  return <div className="rounded-xl px-3.5 py-3" style={{ background: "var(--bg)", border: EDGE }}>{children}</div>;
}
function Cap({ children }: { children: ReactNode }) { return <div className="px-1.5 pb-0.5 text-[10.5px]" style={{ color: "var(--text3)" }}>{children}</div>; }
function Menu({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 rounded-lg p-1.5 text-[11.5px] flex flex-col gap-0.5" style={{ border: EDGE, background: "var(--surface-inset)" }}>{children}</div>;
}
const Item = ({ children, wf }: { children: ReactNode; wf?: boolean }) => (
  <div className="px-1.5 py-1 rounded-md flex gap-1.5 items-center" style={wf ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--primary-ink)" } : undefined}>{children}</div>
);
/* A drawing of a pill inside a mock card: flat fill and no outline, because an outlined pill is how a control looks here and these press nothing. */
const Chip2 = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 rounded-lg px-2 text-[11.5px] cursor-default select-none" style={{ height: 22, background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>{children}</span>
);

function PrView({ steps, linked }: { steps: ReturnType<typeof clickupSteps>; linked: boolean }) {
  const g = (k: string) => steps.find((s) => s.kind === k);
  const mv = g("move"), mn = g("menu"), pp = g("people"), nt = g("note");
  return (
    <Mini>
      <div className="flex gap-2 items-center text-[12px]"><Tag tone="ok">Open</Tag><b className="font-semibold">#318</b><span className="inline-flex items-center gap-1" style={{ color: "var(--text3)" }}>orbit/api · <DoneIcon size={ICON.xs} /> 12 checks</span></div>
      <div className="mt-1.5 mb-1 text-[12.5px]">{sm.title}</div>
      <div className="text-[11.5px]" style={{ color: "var(--text3)" }}>feature/retry-webhook → main</div>
      {linked && (
        <div className="mt-2.5 rounded-lg px-2.5 py-2" style={{ border: LINE, background: "var(--surface-inset)" }}>
          <div className="flex gap-1.5 flex-wrap items-center"><Chip2><Dot type="custom" />{sm.id}</Chip2><Chip2><Dot type="custom" />{sm.status}</Chip2><span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{sm.who}, {sm.others}</span></div>
          {(mv?.status || nt) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {mv?.status && <Chip2>{n.move} {mv.status}</Chip2>}
              {nt && <Chip2><NoteIcon size={ICON.xs} /> Note on {n.item}</Chip2>}
            </div>
          )}
        </div>
      )}
      <Menu>
        <Cap>Review menu</Cap><Item>Request changes</Item><Item>Approve</Item>
        {linked && mn?.status && <Item wf><Dot type="custom" />{n.move} {mn.status}</Item>}
        {linked && pp && <Item wf><UserIcon size={ICON.xs} />Assigned: {sm.who}, {sm.others}</Item>}
      </Menu>
      {!linked && <Menu><Cap>More menu</Cap><Item>Copy link</Item><Item>Open on GitHub</Item><Item wf><LinkIcon size={ICON.xs} />Link a {n.item}… <span style={{ color: "var(--text3)" }}>this machine only</span></Item></Menu>}
    </Mini>
  );
}

function CardView({ writes, linked }: { writes: boolean; linked: boolean }) {
  return (
    <Mini>
      <div className="flex gap-2 items-center text-[12px]"><b className="font-semibold">{sm.id}</b><Chip2><Dot type="custom" />{sm.status}</Chip2>{!writes && <Tag tone="dim">read-only</Tag>}</div>
      <div className="mt-1.5 mb-1 text-[12.5px]">{sm.title}</div>
      <div className="flex gap-1.5 flex-wrap items-center"><span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{sm.who}, {sm.others}</span><Chip2>High</Chip2></div>
      <div className="mt-2 text-[11.5px]" style={{ color: "var(--text3)" }}>Comments 3 · Checklist 2/4 · 1 file</div>
      {linked && <div className="mt-2.5 rounded-lg px-2.5 py-2 text-[11.5px]" style={{ border: LINE, background: "var(--surface-inset)" }}><div style={{ color: "var(--text3)" }} className="mb-1">Pull requests</div><div className="flex gap-1.5 items-center"><Tag tone="ok">Open</Tag> #318 Retry the webhook…</div></div>}
      <div className="mt-2 text-[11.5px]" style={{ color: "var(--text3)" }}>{writes ? "Assign · Comment" : "Read-only until you turn on changes."}</div>
    </Mini>
  );
}
