import { useCallback, useEffect, useRef, useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { CommandLine, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { api } from "../../lib/api.ts";
import { engineProviders, type Provider } from "../../../../shared/agentKinds.ts";
import type { AgentProbe, EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { ReportingRow } from "./ReportingRow.tsx";
import {
  accountText, actionOf, badgeOf, credentialNote, engineState, firstRow, roleBadge, versionText,
} from "./enginesCopy.ts";

/**
 * Which engines this machine has, and what each one can do here.
 *
 * One card per engine, in the order of the provider table, each answering the
 * same questions in the same order so two cards can be read side by side: is it
 * here, is it recent enough, is somebody signed in, what role could it take,
 * how it would be held, and whether it reports to this app. The badge and the
 * one action sit in the card's header in every state, loading included, so
 * nothing moves when the answer arrives.
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

/** A row that says one thing and, when there is a command for it, shows it. */
function Right({ e, now }: { e: EngineReadiness | null; now: number }) {
  const r = firstRow(e, now);
  return (
    <SettingRow label="Right now" minHeight={56}
      hint={withCode(r.text)}
      below={r.command ? <><CommandLine command={r.command} />{r.hint && <p className="m-0 mt-1.5 text-[12px]" style={{ color: "var(--text3)" }}>{r.hint}</p>}</> : undefined} />
  );
}

function EngineCard({ p, e, now, reporting, reportingLoaded, busy, note, onRecheck, onTest, onConnect }: {
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
  const badge = badgeOf(e);
  const act = actionOf(e);
  const kind = p.headless?.argv;
  return (
    <SettingsCard title={p.title} desc={p.what}
      status={<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>}
      actions={<Button disabled={act.disabled} onClick={act.label === "Test" ? onTest : onRecheck}>{act.label}</Button>}>
      <Right e={e} now={now} />
      <SettingRow label="Version" control={textOf(e ? versionText(e) : "…")} />
      <SettingRow label="Account and model" control={textOf(e ? accountText(e) : "…")}
        detail={{ summary: "Where the credential lives", body: withCode(credentialNote(p.title, p.bin, p.account?.args)) }} />
      <SettingRow label="Can work for an orchestrator"
        status={e ? <StatusBadge tone={roleBadge(e.roles.worker).tone}>{roleBadge(e.roles.worker).text}</StatusBadge> : <StatusBadge tone="checking">Checking</StatusBadge>}
        hint={e && !e.roles.worker.ok ? withCode(e.roles.worker.why ?? "") : undefined} />
      <SettingRow label="Can orchestrate"
        status={e ? <StatusBadge tone={roleBadge(e.roles.orchestrator).tone}>{roleBadge(e.roles.orchestrator).text}</StatusBadge> : <StatusBadge tone="checking">Checking</StatusBadge>}
        hint={e && !e.roles.orchestrator.ok ? e.roles.orchestrator.why : undefined} />
      <SettingRow label="What it is held to as a worker"
        hint={e ? <>Its own worktree, with push, pull requests and merges on its deny list. That list is rules over a command line, not a sandbox. {withCode(e.envelope.note)}</> : "…"} />
      <SettingRow label="How agentglass runs it"
        hint={p.headless ? "One turn at a time, with no terminal. This is derived from the provider table, so it is read here and not typed."
          : `agentglass does not know how to run ${p.title} without a terminal yet.`}
        detail={p.headless ? {
          summary: "The command agentglass runs",
          body: (
            <div className="grid gap-2">
              <CommandLine command={`${p.bin} ${p.headless.form}`} />
              <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
                It starts in the worker's own working directory{p.modelFlag ? <>, picks the model with <code className="t-mono">{p.modelFlag}</code></> : null}
                {p.headless.resume ? <>, and a follow-up turn names the session with <code className="t-mono">{p.headless.resume}</code></> : null}.
                {kind === "hermes" ? " A resumed Hermes session restores its own directory and approvals, so agentglass starts a fresh one." : ""}
              </p>
            </div>
          ),
        } : undefined} />
      {reporting
        ? <ReportingRow p={reporting} busy={busy} note={note} onConnect={onConnect} />
        : !reportingLoaded && <SettingRow label="Reporting to agentglass" minHeight={56} status={<StatusBadge tone="checking">Checking</StatusBadge>} />}
    </SettingsCard>
  );
}

export function EnginesPane() {
  const providers = engineProviders();
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [agents, setAgents] = useState<AgentProbe[] | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null);
  // null: not chosen yet, so the card is open when nothing at all is installed.
  const [absentOpen, setAbsentOpen] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback((fresh: boolean | string = false) => {
    void api.engines(fresh).then((r) => { if (alive.current) { setReport(r); setNow(Date.now()); } }).catch(() => { /* a failed read keeps what is on screen */ });
    void api.agents().then((r) => { if (alive.current) setAgents(r.agents); }).catch(() => { if (alive.current) setAgents([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

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
  const absent = rows.filter((r) => engineState(r.e) === "missing");
  const present = rows.filter((r) => engineState(r.e) !== "missing");

  return (
    <>
      <SettingsCard title="This computer">
        <SettingRow label="Host" minHeight={52}
          hint="These answers are this computer's. A phone or a second computer looking at this server sees this machine's engines, not its own."
          control={textOf(report?.host ?? "…")} />
      </SettingsCard>

      {present.map(({ p, e }) => (
        <EngineCard key={p.id} p={p} e={e} now={now} reporting={reportingOf(p)} reportingLoaded={agents !== null}
          busy={busy === (p.probe?.id ?? p.id)} note={note && note.id === (p.probe?.id ?? p.id) ? note : null}
          onRecheck={() => load(p.id)} onTest={() => void test(p.id)} onConnect={(a, undo) => void connect(a, undo)} />
      ))}

      {/* Engines that are not here fold into one card, like the ready ones on
          Tools & services: a machine with two engines shows two cards. */}
      {absent.length > 0 && (
        <SettingsCard title={`${absent.length} not installed`} fold={{ open: absentOpen ?? present.length === 0, onToggle: setAbsentOpen }}>
          {absent.map(({ p, e }) => {
            const r = firstRow(e, now);
            return (
              <SettingRow key={p.id} label={p.title}
                hint={<>{p.what} {withCode(r.text)}</>}
                status={<StatusBadge tone="off">Not installed</StatusBadge>}
                actions={<Button onClick={() => load(p.id)}>Recheck</Button>}
                below={r.command ? <CommandLine command={r.command} /> : undefined} />
            );
          })}
        </SettingsCard>
      )}
    </>
  );
}
