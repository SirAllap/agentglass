import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { clickupPrefs, clickupPrefsSaved } from "../lib/clickupPrefs.ts";
import { __forgetClickupSetup, clickupSetup } from "../lib/clickupSetup.ts";
import { __forgetClickupSpaces, PENDING_CARDS, useClickupSpaces } from "../lib/clickupSpaces.ts";
import { __forgetClickupPrefs } from "../lib/clickupPrefs.ts";
import { CLICKUP, addTurnsWritesOn, clickupAdd, clickupBlocks, clickupRemove, clickupSteps, type PrefsPatch } from "../lib/clickupWorkflow.ts";
import { blocksSentence, peopleButtonLabel, triggerOf } from "../lib/stepBlocksView.ts";
import { allStatuses, countedIds, isActive, moments, movesNothing, resolveImplicit, withCounted, type MapSpace, type StepKind } from "../lib/workflowMap.ts";
import { eyeIds, pageState, partitionUnits, type Partition } from "../lib/workflowLayout.ts";
import { openSettings } from "../lib/openSettings.ts";
import { assignWords } from "../lib/stepAssign.ts";
import { setting } from "../lib/settingsRegistry.ts";
import { DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN, type ClickUpPrefs, type ProviderStatus } from "../../../shared/providers.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../../shared/cardSkills.ts";
import { SettingRow, Switch, Toggle } from "./SettingRow.tsx";
import { Button, INPUT, INPUT_STYLE, LINE, Segmented } from "./workspace/Chrome.tsx";
import { Dot, StatusPopover, type PanelView } from "./StatusPanel.tsx";
import { Badge, ListEye, WorkflowMap } from "./WorkflowMap.tsx";
import { WFM_CSS } from "./workflowMapStyle.ts";
import { CaretIcon, DoneIcon, EyeIcon, LinkIcon, LockIcon, NoteIcon, PlusIcon, EditIcon, UserIcon, WarningIcon } from "../lib/glyphIcons.tsx";
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

/** A section of the page: the grey tray, a header, and what is inside it. `open`/`onToggle` make it a disclosure. */
function Card({ id, title, right, children, open, onToggle, flush }: { id: string; title: string; right?: ReactNode; children: ReactNode; open?: boolean; onToggle?: (o: boolean) => void; flush?: boolean }) {
  const head = (<><div className="agx-settings-head-t">{title}</div>{right}</>);
  return (
    <section className="agx-settings-section" aria-labelledby={id}>
      {onToggle ? (
        <details open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
          <summary className="agx-settings-head agx-fold flex items-center gap-4 list-none" id={id}>
            <span aria-hidden className="flex transition-transform" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", color: "var(--text3)" }}><CaretIcon size={ICON.sm} /></span>
            {head}
          </summary>
          <div className="agx-settings-rows" style={flush ? { padding: 0 } : undefined}>{children}</div>
        </details>
      ) : (
        <>
          <div className="agx-settings-head flex items-center gap-4 flex-wrap" id={id}>{head}</div>
          <div className="agx-settings-rows">{children}</div>
        </>
      )}
    </section>
  );
}

const hint = (c: ReactNode, style?: object) => <span className="text-[11px]" style={{ color: "var(--text3)", ...style }}>{c}</span>;
const micro = (c: ReactNode) => <span className="text-[10px] font-semibold uppercase" style={{ letterSpacing: ".1em", color: "var(--text3)" }}>{c}</span>;
const Fact = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex gap-1 items-baseline text-[11px] px-2 py-0.5 rounded-md" style={{ color: "var(--text3)", background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</span>
);
const Tagged = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 px-2 rounded-md text-[11px]" style={{ height: 20, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</span>
);

const ago = (at: number): string => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Which spaces count: a checklist over every space the page knows, in a popover. Ignoring one folds it away; it is not deleted. */
function CountedPicker({ units, chosen, onChange, onReset, onClose }: { units: readonly MapSpace[]; chosen: boolean; onChange: (ids: string[]) => void; onReset: () => void; onClose: () => void }) {
  const all = units.filter((u) => !u.fromList);
  const [last, setLast] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[role=option]")?.focus(); }, []);
  /* The ticks follow the press at once and the saved answer catches up: two presses in a row each start from the last one. */
  const [ids, setIds] = useState(() => countedIds(units));
  useEffect(() => { setIds(countedIds(units)); }, [units]);
  const toggle = (u: MapSpace) => {
    const next = ids.includes(u.id) ? ids.filter((x) => x !== u.id) : [...ids, u.id];
    setLast(next.length === 0);
    if (!next.length) return;
    setIds(next);
    onChange(next);
  };
  return (
    <div ref={ref} className="wfm wfm-pop" role="listbox" aria-multiselectable="true" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      aria-label={`${n.spaces[0]!.toUpperCase()}${n.spaces.slice(1)} that count`}>
      <div className="px-2 pt-1 pb-1 text-[11px]" style={{ color: "var(--text3)" }}>Steps are judged against the {n.spaces} that count. Ignoring one folds it away; it is not deleted.</div>
      <div className="wfm-lst">
        {all.map((u) => (
          <button key={u.id} type="button" role="option" aria-selected={ids.includes(u.id)} className="wfm-opt" onClick={() => toggle(u)}>
            <span className="ck" aria-hidden>{ids.includes(u.id) ? <DoneIcon size={ICON.xs} /> : null}</span>
            <span className="n"><b>{u.name}</b>{u.group && <span className="block text-[11px]" style={{ color: "var(--text3)" }}>{u.group}</span>}</span>
            <span className="m">{u.statuses.length} statuses</span>
          </button>
        ))}
      </div>
      {last && <div role="status" className="px-2 text-[11px]" style={{ color: "var(--warning-ink)" }}>At least one {n.space} has to count: with none there is no status to pick.</div>}
      {chosen && <div className="pt-1" style={{ borderTop: LINE }}><Button size="compact" onClick={onReset}>Back to the default</Button></div>}
    </div>
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
    __forgetClickupSetup(); __forgetClickupPrefs(); __forgetClickupSpaces();
    onDone();
  };
  const reasons: [ReactNode, string, string][] = [
    [<EyeIcon size={ICON.md} />, "Reads first", `The ${n.lists} where your tasks live, their statuses and two fields. Nothing else leaves ${n.name}.`],
    [<LockIcon size={ICON.md} />, "Read-only until you say", "Changes are off by default, and each step acts only when its button is pressed."],
    [<PlusIcon size={ICON.md} />, "Your statuses, not ours", `A step moves a ${n.item} to one of your own statuses. None are assumed.`],
  ];
  return (
    <section className="agx-settings-section" aria-label="Connect">
      <div className="grid gap-6 p-6" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)" }}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid place-items-center rounded-full font-bold text-[15px]" style={{ width: 40, height: 40, background: "var(--surface-inset)" }}>C</span>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2"><h1 className="m-0 text-[18px] font-bold">{n.name}</h1><Badge tone={refused ? "err" : undefined}>{refused ? "Token refused" : "Not connected"}</Badge></div>
              {hint("Link it once and a pull request knows its card.")}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="cu-token" className="text-[10px] font-semibold uppercase" style={{ letterSpacing: ".1em", color: "var(--text3)" }}>Personal API token</label>
            <div className="flex gap-2">
              <input id="cu-token" type="password" value={token} placeholder="pk_…" autoComplete="off" spellCheck={false}
                aria-invalid={bad} aria-describedby="cu-token-h" onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
                className={`flex-1 min-w-0 ${INPUT}`} style={{ ...INPUT_STYLE, ...(bad ? { borderColor: "var(--error)", background: "color-mix(in srgb, var(--error) 11%, var(--bg))" } : null) }} />
              <Button tone="primary" size="regular" pending={busy} disabled={!token.trim()} onClick={() => void go()}>Connect</Button>
            </div>
            {bad
              ? <div id="cu-token-h" role="alert" className="flex gap-2 items-start text-[13px]" style={{ color: "var(--error-ink)" }}>
                <span className="shrink-0 mt-0.5"><WarningIcon size={ICON.md} /></span>
                <span><b>{`${(err ?? error ?? `${n.name} no longer accepts this token`).replace(/[.\s]+$/, "")}.`}</b> {err ? "Copy it again whole, without blanks. Nothing was saved." : "Your steps are kept exactly as they are; they resume once you reconnect."}</span>
              </div>
              : hint(<span id="cu-token-h">{n.name} → avatar → Settings → Apps → API token.</span>)}
          </div>
        </div>
        <ul className="m-0 p-0 flex flex-col gap-3" style={{ listStyle: "none" }}>
          {reasons.map(([ic, t, d]) => (
            <li key={t} className="flex gap-3 items-start">
              <span aria-hidden className="grid place-items-center rounded-full shrink-0" style={{ width: 24, height: 24, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)", color: "var(--primary)" }}>{ic}</span>
              <span className="text-[13px]"><b>{t}</b><br />{hint(d)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The map before ClickUp is connected: there is nothing to draw yet, and Add is not offered. */
export function WaitingMap() {
  return (
    <section className="agx-settings-section" aria-label="Workflow map">
      <div className="agx-settings-head flex items-center gap-4">
        <div className="flex flex-col gap-0.5 flex-1"><div className="agx-settings-head-t">Workflow map</div>{hint(`Appears once ${n.name} is connected.`)}</div>
        <Button tone="primary" disabled><PlusIcon size={ICON.xs} /> Add a step</Button>
      </div>
    </section>
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
      <div className="wfm flex flex-col gap-6">
        <style>{WFM_CSS}</style>
        <ConnectCard refused={st === "refused"} error={state.kind === "error" ? state.error : null} onDone={() => { setEpoch((e) => e + 1); reread(); }} />
        <WaitingMap />
      </div>
    );
  }

  return (
    <div className="wfm flex flex-col gap-6">
      <style>{WFM_CSS}</style>
      <section className="agx-settings-section" aria-label="Connection">
        <div className="grid items-center gap-6 p-6" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
          <div className="flex items-center gap-4 min-w-0">
            <span aria-hidden className="grid place-items-center rounded-full font-bold text-[15px] shrink-0" style={{ width: 40, height: 40, background: "var(--primary)", color: "var(--on-primary)" }}>{(provider?.detail?.match(/as (\S)/)?.[1] ?? "C").toUpperCase()}</span>
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-2 flex-wrap"><h1 className="m-0 text-[18px] font-bold">{n.name}</h1><Badge tone="ok">Connected</Badge></div>
              {provider?.detail && hint(provider.detail)}
              <div className="flex gap-2 mt-2"><Button size="compact" onClick={() => openSettings("connections")}>Manage connection</Button></div>
            </div>
          </div>
          <div className="flex items-center gap-4 px-4 py-3 rounded-xl" data-guard={changesOn ? "on" : "off"}
            style={changesOn
              ? { background: "color-mix(in srgb, var(--warning) 16%, var(--bg))", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 55%, transparent)" }
              : { background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>
            <span style={{ color: changesOn ? "var(--warning-ink)" : "var(--text3)" }}>{changesOn ? <EditIcon size={ICON.md} /> : <LockIcon size={ICON.md} />}</span>
            <div className="flex flex-col gap-0.5" style={{ maxWidth: 340 }}>
              <b id="cu-changes-l" className="text-[13px]">{changesOn ? `Changes in ${n.name}: on` : "Read-only"}</b>
              {hint(changesOn ? `Only the steps below can change a ${n.item}, one at a time, when you press their button.` : steps.length ? "agentglass only reads. Turn this on to let the steps below act." : "agentglass only reads. Adding your first step turns this on.")}
            </div>
            <button type="button" role="switch" aria-checked={changesOn} aria-labelledby="cu-changes-l" disabled={writes === null}
              onClick={() => void setChanges(!changesOn)} className="agx-switch-hit inline-flex items-center rounded-full" style={{ minHeight: HIT }}><Switch on={changesOn} /></button>
          </div>
        </div>
      </section>

      <Card id="cu-found" title="What we found" open={foundOpen ?? steps.length === 0} onToggle={setFoundOpen} flush
        right={<>
          <Badge tone={state.kind === "error" ? "warn" : state.kind === "loading" ? "dim" : "ok"}>{reading ? "Reading your cards…" : state.kind === "loading" ? "Reading…" : state.kind === "error" ? (asOf ? `As of ${ago(asOf)}` : "Not read") : "Read-only"}</Badge>
          <span className="flex gap-2 flex-wrap ml-auto">
            {!reading && <Fact><b className="text-[13px]" style={{ color: "var(--text)" }}>{part.counted.length}</b> {n.lists} count</Fact>}
            {!reading && <Fact><b className="text-[13px]" style={{ color: "var(--text)" }}>{distinct}</b> statuses</Fact>}
            {part.folded.length > 0 && <Fact><b className="text-[13px]" style={{ color: "var(--text)" }}>{part.folded.length}</b> ignored</Fact>}
            {prefs.prLinkField && <Fact>PR link <b style={{ color: "var(--text)" }}>{prefs.prLinkField}</b></Fact>}
            {prefs.swatchField && <Fact>Swatch <b style={{ color: "var(--text)" }}>{prefs.swatchField}</b></Fact>}
          </span>
        </>}>
        <div className="flex items-center gap-3 flex-wrap px-6 pt-4">
          <span className="text-[13px]"><b>{`${n.lists[0]!.toUpperCase()}${n.lists.slice(1)} that count:`}</b> {countWord(part)}</span>
          <Button size="compact" aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button>
          {hint(chosen ? "You chose these. The rest are ignored, not deleted." : state.kind === "ok" && state.note ? state.note : `Where your ${n.items} live, until you choose.`)}
        </div>
        <div className="grid gap-6 p-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="flex flex-col gap-2">
            {micro(`Your ${n.lists} and their statuses`)}
            {state.kind === "loading" && !units.length ? hint("reading…")
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
              ) : hint(`No ${n.list} counts.`)}
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {micro("Not used by steps")}
              {hint(part.folded.length ? `${part.folded.length} ${chosen ? "ignored" : `other ${n.spaces}`} (${part.folded.map((f) => f.unit.name).join(", ")}). Their statuses stay out of the picker until you open them.` : "Nothing is folded away.")}
            </div>
            <div className="flex flex-col gap-2">
              {micro("How we read it")}
              <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Task ids {prefix ? <><Tagged>{prefix}n</Tagged>{hint("custom ids")}</> : hint("default; a custom prefix is read from the first board you open")}</div>
              <div className="flex gap-2 items-baseline flex-wrap text-[13px]">PR link {prefs.prLinkField ? <Tagged>{prefs.prLinkField}</Tagged> : hint("a field with “github” in its name")}<Button size="compact" onClick={showAdvanced}>Change</Button></div>
              <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Swatch {prefs.swatchField ? <Tagged>{prefs.swatchField}</Tagged> : hint("guessed from the field names")}<Button size="compact" onClick={showAdvanced}>Change</Button></div>
              <div className="flex gap-2 items-baseline flex-wrap text-[13px]">Sprints {prefs.sprintListPattern === DEFAULT_SPRINT_LIST_PATTERN ? hint("lists named like “Sprint 12”, and dated ones") : <><Tagged>{prefs.sprintListPattern}</Tagged>{hint("and dated ones")}</>}<Button size="compact" onClick={showAdvanced}>Change</Button></div>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: "var(--text3)" }}>
              {asOf && state.kind === "ok" ? `Read ${ago(asOf)} · cached for 10 min.` : "Nothing needs setting up."}
              <Button size="compact" onClick={reread} disabled={frozen || state.kind === "loading"}>Re-read</Button>
            </div>
          </div>
        </div>
      </Card>
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker units={units} chosen={chosen} onChange={count} onReset={() => count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}

      <WorkflowMap adapter={CLICKUP} part={part} panel={panel} steps={steps} changesOn={changesOn} frozen={frozen} source={source}
        onHover={setHover}
        onAdd={async (kind) => {
          const ok = await send(clickupAdd(kind));
          if (ok && addTurnsWritesOn(changesOn, steps.length)) await setChanges(true);
          return ok;
        }}
        onBlocks={(kind, blocks) => { const t = triggerOf(kind); if (t) void send(clickupBlocks(t, blocks)); }}
        onRemove={(kind) => { void send(clickupRemove(kind)); }}
        people={readPeople}
        onToggleCounted={toggleCounted}
        onCountAgain={(u) => { const ids = withCounted(units, u.fromList && u.spaceId ? u.spaceId : u.id, true); if (ids) count(ids); }}
        onRetry={reread} />
      {note && <div role="alert" className="text-[11px] -mt-4" style={{ color: "var(--error-ink)" }}>{note}</div>}

      <Card id="cu-shows" title="Where this shows up"
        right={<><span className="flex-1" />{hint("Hover a step above to see which part of this it adds.")}<Segmented label={`Does the pull request name a ${n.item}?`} value={linked ? "1" : "0"} onChange={(v) => setLinked(v === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} /></>}>
        <div className="grid gap-6 p-6" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <div><PrView steps={live} all={steps} writes={changesOn} hover={hover} linked={linked} /></div>
          <div><CardView writes={changesOn} linked={linked} /></div>
        </div>
        <div className="px-6 pb-4 text-[11px]" style={{ color: "var(--text3)" }}>
          {live.length ? `Only the steps above show up. Everything else about a ${n.item} stays read-only.`
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

const sm = CLICKUP.sample;
/** The part of a mini view that a hovered step adds: it lights up, so the person sees where the step lands. */
const lit = (hover: StepKind | null, k: StepKind) => (hover === k ? "wfm-hlx" : undefined);
function Mini({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 items-center p-3 rounded-xl" style={{ background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</div>;
}
function Pane({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 p-4 rounded-xl" style={{ background: "var(--bg)", boxShadow: "0 0 0 1px var(--w-edge, var(--border))" }}>{children}</div>;
}
function Menu({ children }: { children: ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-xl" style={{ boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</div>;
}
const Item = ({ children, cls }: { children: ReactNode; cls?: string }) => (
  <div className={`px-3 py-2 text-[13px] flex gap-2 items-center ${cls ?? ""}`} style={{ borderTop: LINE }}>{children}</div>
);
/* A drawing of a pill inside a mock card: flat fill and no outline, because an outlined pill is how a control looks here and these press nothing. */
const Chip2 = ({ children, cls }: { children: ReactNode; cls?: string }) => (
  <span className={`inline-flex items-center gap-1 px-2 rounded-md text-[11px] font-semibold cursor-default select-none ${cls ?? ""}`} style={{ height: 24, background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>{children}</span>
);

function PrView({ steps, all, writes, hover, linked }: { steps: ReturnType<typeof clickupSteps>; all: ReturnType<typeof clickupSteps>; writes: boolean; hover: StepKind | null; linked: boolean }) {
  const g = (k: string) => steps.find((s) => s.kind === k);
  const mv = g("move"), mn = g("menu"), pp = g("people"), nt = g("note");
  const mg = all.find((s) => s.kind === "merge");
  /* A button shows once it does something: a status to move to, or people to change. */
  const mvOn = !!mv && (!!mv.status || (movesNothing(mv) && (mv.unassign !== "none" || mv.assign.who !== "none")));
  return (
    <Pane>
      <div className="flex gap-2 items-center text-[13px]"><Chip2>Open</Chip2><b>#318</b>{hint("orbit/api · 12 checks passed")}</div>
      <div className="text-[13px]">{sm.title}</div>
      {linked ? (
        <>
          <Mini>
            <Chip2><Dot type="custom" />{sm.id}</Chip2><Chip2><Dot type="custom" />{sm.status}</Chip2>
            {mvOn && <Chip2 cls={lit(hover, "move")}>{mv!.status ? `${n.move} ${mv!.status}` : peopleButtonLabel(mv!)}</Chip2>}
            {nt && <Chip2 cls={lit(hover, "note")}><NoteIcon size={ICON.xs} /> Note</Chip2>}
            {!mvOn && !nt && hint("No control from a step here.")}
          </Mini>
          {mvOn && <div className={lit(hover, "move")} data-preview="move">{hint(blocksSentence({ lead: "Press the button:", trigger: "move", blocks: mv!.blocks ?? [], item: n.item, status: mv!.status }))}</div>}
          <Menu>
            <div className="px-3 py-2 text-[13px]">Request changes</div>
            <Item>Approve</Item>
            {mn?.status && <Item cls={lit(hover, "menu")}><span style={{ color: "var(--primary)", fontWeight: 700 }}>{n.move} {mn.status}</span>{assignWords(mn.assign) && hint(`and assigns ${assignWords(mn.assign)}`)}</Item>}
            {mn && !mn.status && movesNothing(mn) && mn.assign.who !== "none" && <Item cls={lit(hover, "menu")}><span style={{ color: "var(--primary)", fontWeight: 700 }}>{peopleButtonLabel(mn)}</span></Item>}
            {pp && <Item cls={lit(hover, "people")}><UserIcon size={ICON.xs} />Assigned · {sm.who}, {sm.others}</Item>}
          </Menu>
          {hint(mg && writes ? <>Merge dialog: <span className={lit(hover, "merge")} style={{ fontWeight: 700, color: "var(--text)" }}>{n.move} {sm.id} to {mg.status ?? "Leave it there"}</span>{mg.status && assignWords(mg.assign) && <> and assigns {assignWords(mg.assign)}</>}</> : "Merge dialog: no extra option.")}
        </>
      ) : (
        <>
          <Mini>{hint(`No ${n.item} is linked to this pull request, so none of the steps show on it.`)}</Mini>
          <Menu><div className="px-3 py-2 text-[13px]">Request changes</div><Item>Approve</Item><Item><LinkIcon size={ICON.xs} />Link a {n.item}… {hint("this machine only")}</Item></Menu>
        </>
      )}
    </Pane>
  );
}

function CardView({ writes, linked }: { writes: boolean; linked: boolean }) {
  return (
    <Pane>
      <div className="flex gap-2 items-center text-[13px]"><b>{linked ? sm.id : `No ${n.item}`}</b>{linked && <Chip2><Dot type="custom" />{sm.status}</Chip2>}{linked && !writes && <Badge>Read-only</Badge>}</div>
      {linked ? (
        <>
          <div className="text-[13px]">{sm.title}</div>
          {hint(`${sm.who}, ${sm.others} · High`)}
          <Mini>{hint("Pull requests")}<Chip2>Open</Chip2><span className="text-[13px]">#318 Retry the webhook…</span></Mini>
          <div className="flex gap-2"><Chip2>Assign</Chip2><Chip2>Comment</Chip2></div>
          {!writes && hint("Read-only until you turn on changes.")}
        </>
      ) : hint(`Link a pull request to a ${n.item} to see the ${n.item} here.`)}
    </Pane>
  );
}
