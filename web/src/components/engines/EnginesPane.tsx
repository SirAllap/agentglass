import { useCallback, useEffect, useRef, useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { CommandLine, EmptyState, ProblemNote, SegControl, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { useReportHead, useReportNeeds, useReportProblem } from "../SettingsPageState.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { api } from "../../lib/api.ts";
import { refreshProviderUsage, usageOf } from "../../lib/usageStore.ts";
import { CaretIcon, DoneIcon, IconLabel, InfoIcon, MinusIcon, PlusIcon, SearchIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { homeShort } from "../../lib/pluginDeclarationLayout.ts";
import { engineProviders, type Provider } from "../../../../shared/agentKinds.ts";
import type { AgentProbe, EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { ReportingRow } from "./ReportingRow.tsx";
import {
  accountText, actionOf, badgeOf, credentialNote, engineCounts, engineState, firstRow, logoOf, reportingCheck, roleBadge,
  tileChecks, versionLine, versionText, type TileCheck,
} from "./enginesCopy.ts";
import { readEngines } from "./readEngines.ts";

/**
 * Which engines this machine has, and what each one can do here.
 *
 * One tile per engine, in the order of the provider table, each answering the
 * same questions in the same order so two tiles can be read side by side: is it
 * here, is somebody signed in, does it report to this app, what role could it
 * take, and has it ever answered. The badge sits in the tile's header in every
 * state, loading included, so nothing moves when the answer arrives. The
 * longer answers (what it is held to, where the credential lives, the wiring)
 * are behind the tile's Details.
 *
 * Nothing here polls. The page loads when it opens and again on Recheck; the
 * server caches what the CLIs printed by the binary's and the config
 * directory's mtime, so opening it twice costs nothing. The one-line test is
 * a real turn, so it runs only when a button is pressed.
 */

/** A sentence with `command` pieces drawn as code, the way the words were written. */
const withCode = (text: string) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={i} className="t-mono">{part}</code> : part));

const textOf = (s: string) => <span className="text-[12.5px]" style={{ color: "var(--text2)" }}>{s}</span>;

/** The tile's one disclosure; what it holds is named for a screen reader on the button. */
const DETAILS = "Details";

/** One line of a tile's checklist: the mark says whether it is fine, the words say what it is. */
function Check({ c }: { c: TileCheck }) {
  return (
    <div className="agx-ck" data-state={c.state}>
      <span aria-hidden className="agx-ck-i">{c.state === "ok" ? <DoneIcon size={ICON.sm} /> : c.state === "warn" ? <WarningIcon size={ICON.sm} /> : <MinusIcon size={ICON.sm} />}</span>
      <span>{c.label}</span>
      <em title={c.value}>{c.value}</em>
    </div>
  );
}

function EngineTile({ p, e, now, reporting, reportingLoaded, busy, note, onRecheck, onTest, onConnect }: {
  p: Provider;
  e: EngineReadiness | null;
  now: number;
  reporting: AgentProbe | null;
  /** False until the roster has answered, so its row is there, waiting, from the start. */
  reportingLoaded: boolean;
  busy: boolean;
  note: { text: string; bad: boolean } | null;
  onRecheck: () => void;
  onTest: () => void;
  onConnect: (a: AgentProbe, undo: boolean) => void;
}) {
  const [more, setMore] = useState(false);
  /* Codex's quota is read by running one minimal turn, which spends a little of the quota it measures:
     so it is a button you press, and what came back is said under the checks. */
  const [usage, setUsage] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  const readUsage = async () => {
    setUsage({ busy: true, text: null });
    const r = await api.refreshCodexUsage().catch(() => null);
    if (!r?.ok) { setUsage({ busy: false, text: "Could not read it: Codex did not answer." }); return; }
    await refreshProviderUsage();
    const w = (usageOf("codex")?.windows ?? []).filter((x) => x.minutes >= 1440).sort((a, b) => b.usedPercent - a.usedPercent)[0];
    setUsage({ busy: false, text: w ? `${Math.round(w.usedPercent)} % of the ${w.label} window used.` : "Read, but Codex reported no long window." });
  };
  const state = engineState(e);
  const badge = badgeOf(e);
  const act = actionOf(e);
  const kind = p.headless?.argv;
  const first = firstRow(e, now);
  const fix = state === "missing" || state === "old" || state === "signin" || state === "broken";
  const checks = state === "missing" && e
    ? [{ state: "no" as const, label: "Installed", value: "Not on this machine" }]
    : tileChecks(e, now, reportingCheck(reporting, reportingLoaded, now));
  checks.forEach((c) => { if (c.label === "Installed" && e?.path) c.value = homeShort(e.path); });
  return (
    <article className="agx-tile" data-attn={state === "ready" || state === "checking" || state === "missing" || state === "testing" ? undefined : "true"} data-none={state === "missing" ? "true" : undefined}
      aria-label={p.title}>
      <div className="agx-tile-h">
        <span aria-hidden className="agx-tile-logo" style={{ background: logoOf(p.id) }}>{p.title.charAt(0)}</span>
        <div className="agx-tile-id"><h3>{p.title}</h3><small>{versionLine(e)}</small></div>
        <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
      </div>
      <div className="agx-ck-list">{checks.map((c) => <Check key={c.label} c={c} />)}</div>
      {/* The next thing to do, with its command, only while there is one to do. */}
      {fix && (
        <div className="agx-tile-fix">
          <p>{withCode(first.text)}</p>
          {first.command && <CommandLine command={first.command} />}
          {first.hint && <p className="agx-tile-hint">{first.hint}</p>}
        </div>
      )}
      <div className="agx-tile-f">
        {state === "missing"
          ? <Button tone="primary" onClick={() => setMore(true)}>Install guide</Button>
          : <>
            {reporting && !reporting.connected && reporting.found && (
              <Button tone="primary" disabled={busy} onClick={() => onConnect(reporting, false)}>{busy ? "…" : "Wire hooks"}</Button>
            )}
            {state === "old" && <Button tone="primary" onClick={() => setMore(true)}>Update</Button>}
            <Button disabled={act.disabled} onClick={act.label === "Test" ? onTest : onRecheck}>{act.label}</Button>
            {p.id === "codex" && state === "ready" && (
              <Button pending={usage.busy} onClick={() => void readUsage()} title="Runs one minimal Codex turn: it spends a little of the quota it measures">Read usage</Button>
            )}
          </>}
        {state === "missing" && <Button onClick={onRecheck}>Recheck</Button>}
        <span className="flex-1" />
        <button type="button" className="agx-tile-more" aria-expanded={more} aria-label={`Details of ${p.title}`} onClick={() => setMore((m) => !m)}>
          {DETAILS}<CaretIcon size={ICON.xs} />
        </button>
      </div>
      {usage.text && <p className="agx-tile-hint" role="status">{usage.text}</p>}
      {more && (
        <div className="agx-tile-d agx-scard-body">
          <SettingRow label="Right now" hint={withCode(first.text)}
            below={first.command ? <CommandLine command={first.command} /> : undefined} />
          <SettingRow label="Version" control={textOf(e ? versionText(e) : "…")} />
          <SettingRow label="Account and model" control={textOf(e ? accountText(e) : "…")}
            detail={{ summary: "Where the credential lives", body: withCode(credentialNote(p.title, p.bin, p.account?.args)) }} />
          <SettingRow label="Can work for an orchestrator"
            status={e ? <StatusBadge tone={roleBadge(e.roles.worker).tone}>{roleBadge(e.roles.worker).text}</StatusBadge> : <StatusBadge tone="checking">Checking</StatusBadge>}
            hint={e && !e.roles.worker.ok ? withCode(e.roles.worker.why ?? "") : undefined}
            detail={{
              summary: "What it is held to, and how agentglass runs it",
              body: (
                <div className="grid gap-2">
                  <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
                    {e ? <>Held to its own worktree, with push, pull requests and merges on its deny list. That list is rules over a command line, not a sandbox. {withCode(e.envelope.note)}</> : "…"}
                  </p>
                  <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
                    {p.headless ? "Run one turn at a time, with no terminal. This is derived from the provider table, so it is read here and not typed."
                      : `agentglass does not know how to run ${p.title} without a terminal yet.`}
                  </p>
                  {p.headless && (
                    <>
                      <CommandLine command={`${p.bin} ${p.headless.form}`} />
                      <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
                        It starts in the worker's own working directory{p.modelFlag ? <>, picks the model with <code className="t-mono">{p.modelFlag}</code></> : null}
                        {p.headless.resume ? <>, and a follow-up turn names the session with <code className="t-mono">{p.headless.resume}</code></> : null}.
                        {kind === "hermes" ? " A resumed Hermes session restores its own directory and approvals, so agentglass starts a fresh one." : ""}
                      </p>
                    </>
                  )}
                </div>
              ),
            }} />
          <SettingRow label="Can orchestrate"
            status={e ? <StatusBadge tone={roleBadge(e.roles.orchestrator).tone}>{roleBadge(e.roles.orchestrator).text}</StatusBadge> : <StatusBadge tone="checking">Checking</StatusBadge>}
            hint={e && !e.roles.orchestrator.ok ? e.roles.orchestrator.why : undefined} />
          {reporting
            ? <ReportingRow p={reporting} busy={busy} note={note} onConnect={onConnect} />
            : !reportingLoaded && <SettingRow label="Reports to agentglass" status={<StatusBadge tone="checking">Checking</StatusBadge>} />}
          <SettingRow label="Hook settings" hint={`The wiring for ${p.title} is written on the Agents page.`}
            actions={<Button onClick={() => openSettings("hooks")}>Open settings</Button>} />
        </div>
      )}
    </article>
  );
}

/** The dashed tile that says how any other CLI joins: it only has to POST an event. */
function AddCli() {
  const [open, setOpen] = useState(false);
  return (
    <div className="agx-tile agx-tile-add" data-none="true">
      <button type="button" className="agx-tile-addb" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <PlusIcon size={ICON.md} /><b>Add another CLI</b>
        <span>Anything that speaks the hook protocol shows up here.</span>
      </button>
      {open && (
        <div className="agx-tile-fix">
          <p>Send one event from its hook. A session appears as soon as it arrives; <code className="t-mono">source_app</code>, <code className="t-mono">session_id</code> and <code className="t-mono">hook_event_type</code> are the three fields it needs.</p>
          <CommandLine command={`curl -sS ${(typeof location === "undefined" ? "http://localhost:4000" : location.origin)}/ingest -H 'content-type: application/json' -d '{"source_app":"my-cli","session_id":"s1","hook_event_type":"SessionStart"}'`} />
        </div>
      )}
    </div>
  );
}

export function EnginesPane() {
  const providers = engineProviders();
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [agents, setAgents] = useState<AgentProbe[] | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The last scan did not come back. What is on screen is the one before (or nothing yet). */
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback((fresh: boolean | string = false) => {
    void readEngines((again) => api.engines(again ? true : fresh), (r) => { setReport(r); setNow(Date.now()); setFailed(false); }, { alive: () => alive.current }).catch(() => { if (alive.current) setFailed(true); });
    void api.agents().then((r) => { if (alive.current) setAgents(r.agents); }).catch(() => { if (alive.current) setAgents([]); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useReportProblem("engines", failed ? { chip: "Not scanned", title: "Could not scan this machine for agent CLIs." } : null, () => load(true));

  const test = async (id: string) => {
    setTesting((s) => new Set(s).add(id));
    await api.testEngine(id).catch(() => null);
    if (!alive.current) return;
    setTesting((s) => { const n = new Set(s); n.delete(id); return n; });
    load();
  };

  const connect = async (a: AgentProbe, undo: boolean) => {
    setBusy(a.id);
    setNote(null);
    const r = await api.agentConnect(a.id, undo).catch(() => null);
    if (!alive.current) return;
    setBusy(null);
    if (r?.agents) setAgents(r.agents);
    // The script's own words when it has some: it knows the config already
    // pointed here, or that the person has an `[otel]` block it will not touch.
    const text = r?.detail || r?.error || (r?.ok ? "" : "Could not write the config.");
    if (text) setNote({ id: a.id, text, bad: !r?.ok });
    load();
  };

  const readiness = (p: Provider): EngineReadiness | null => {
    const e = report?.engines.find((x) => x.id === p.id) ?? null;
    return e && testing.has(p.id) ? { ...e, answers: { state: "running" } } : e;
  };
  const reportingOf = (p: Provider): AgentProbe | null => agents?.find((a) => a.id === (p.probe?.id ?? p.id)) ?? null;

  const rows = providers.map((p) => ({ p, e: readiness(p) }));
  const counts = engineCounts(rows.map((r) => engineState(r.e)));
  const needs = rows.filter((r) => !["ready", "checking", "missing"].includes(engineState(r.e)));
  const [view, setView] = useState<"all" | "ready" | "needs" | "absent">("all");
  /* The "Needs you" filter, the tiles' badges, the header chip and the nav mark are the same count. */
  useReportNeeds("engines", report && needs.length ? { count: needs.length, title: `${needs.length === 1 ? needs[0]!.p.title : `${needs.length} engines`} ${needs.length === 1 ? "needs" : "need"} sign-in or setup` } : null);
  useReportHead("engines", report ? { chips: [
    ...(counts.ready ? [{ tone: "ok" as const, text: `${counts.ready} ready` }] : []),
    ...(counts.needs ? [{ tone: "warn" as const, text: `${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you` }] : []),
    ...(counts.absent ? [{ tone: "off" as const, text: `${counts.absent} not installed` }] : []),
  ] } : null);
  const shown = rows.filter((r) => {
    const s = engineState(r.e);
    return view === "all" || (view === "ready" ? s === "ready" : view === "needs" ? needs.includes(r) : s === "missing");
  });

  return (
    <>
      {/* The tiles are one per engine, so the bar says how many are in each
          state and cuts the list to one of them; the counts are read from the
          same answers the tiles are drawn from. */}
      {failed && (
        <SettingsCard title="This machine" tone="error" wide>
          <ProblemNote title="Could not scan for agent CLIs" action={<Button onClick={() => load(true)}>Try again</Button>}>
            The local server did not answer{report ? ", so the tiles below are from the last scan that did" : ""}. Nothing was changed.
          </ProblemNote>
        </SettingsCard>
      )}
      <div className="agx-tiles-bar">
        <SegControl<typeof view> label="Show engines" value={view} onPick={setView}
          options={[
            { v: "all", label: `All ${counts.all}` },
            { v: "ready", label: `Ready ${counts.ready}` },
            { v: "needs", label: `Needs you ${counts.needs}` },
            { v: "absent", label: `Not installed ${counts.absent}` },
          ]} />
        <span className="flex-1" />
        <Button onClick={() => load(true)}><IconLabel icon={<SearchIcon size={ICON.xs} />}>Rescan this machine</IconLabel></Button>
      </div>

      <div className="agx-tiles">
        {shown.map(({ p, e }) => (
          <EngineTile key={p.id} p={p} e={e} now={now} reporting={reportingOf(p)} reportingLoaded={agents !== null}
            busy={busy === (p.probe?.id ?? p.id)} note={note && note.id === (p.probe?.id ?? p.id) ? note : null}
            onRecheck={() => load(p.id)} onTest={() => void test(p.id)} onConnect={(a, undo) => void connect(a, undo)} />
        ))}
        {view === "all" && <AddCli />}
      </div>
      {!shown.length && <EmptyState>Nothing in this state.</EmptyState>}

      <p className="agx-tiles-host">
        <InfoIcon size={ICON.sm} />
        <span>These answers are this computer's{report?.host ? <> (<b>{report.host}</b>)</> : null}. A phone or a second computer looking at this server sees this machine's engines, not its own.</span>
      </p>
    </>
  );
}
