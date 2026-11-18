import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type SeatAnswer } from "../../lib/api.ts";
import type { PendingGate } from "../../../../shared/types.ts";
import type { SettingRequestView } from "../../../../shared/settingClass.ts";
import { subscribeLantern, lanternRows, lanternChairs, refreshLantern } from "../../lib/lanternStore.ts";
import type { LanternRow } from "../LanternView.tsx";
import type { AgentSchedule } from "../LanternSchedule.tsx";
import { forgottenPorts, type Forgotten } from "../../lib/portsForgotten.ts";
import { subscribeGates, listGates, pollGatesNow } from "../../lib/gateStore.ts";
import { settingsRequests, settingsRequestsChanged } from "../../lib/settingsRequests.ts";
import { useVisibleInterval } from "../../lib/visibleInterval.ts";
import { pickerProjects } from "../../lib/agentRulesView.ts";

/*
 * EVERYTHING THE AGENTS SCREEN READS, in one place.
 *
 * Each source is the one the app already has — the board (lanternStore, one
 * reader for the whole app), a project's `/seat`, the gates waiting on you, the settings
 * requests, a scan of listening ports, the schedules — read on the clock that
 * source needs and only while the screen is on show. Nothing is read twice and
 * nothing here decides anything: the decisions are in lib/agentsScreen.ts.
 */

export const ALL = "all";
const SCOPE_KEY = "agentglass.agents.scope";

const readScope = (): string | null => { try { return localStorage.getItem(SCOPE_KEY); } catch { return null; } };
const keepScope = (s: string) => { try { localStorage.setItem(SCOPE_KEY, s); } catch { /* a convenience, not state */ } };

export interface AgentsData {
  scope: string;
  setScope: (s: string) => void;
  /** Projects the selector offers: the open ones, and any with a coordinator. */
  projects: string[];
  /** Every row on the board, machine-wide. */
  rows: LanternRow[] | null;
  /** The rows of the chosen scope. */
  scoped: LanternRow[];
  seat: SeatAnswer | null;
  gates: PendingGate[];
  requests: SettingRequestView[];
  forgotten: Forgotten[];
  schedules: AgentSchedule[];
  hooksReady: boolean | null;
  checkedAt: number;
  error: string;
  reload: () => void;
}

const under = (path: string | null | undefined, root: string) => !!path && (path === root || path.startsWith(root.replace(/\/+$/, "") + "/"));

export function useAgents(active: boolean): AgentsData {
  const rows = useSyncExternalStore((l) => subscribeLantern(l, active), lanternRows, lanternRows);
  const chairs = useSyncExternalStore((l) => subscribeLantern(l, false), lanternChairs, lanternChairs);
  const [open, setOpen] = useState<string[]>([]);
  const [scope, setScopeState] = useState<string>(() => readScope() ?? "");
  const [seat, setSeat] = useState<SeatAnswer | null>(null);
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [requests, setRequests] = useState<SettingRequestView[]>([]);
  const [ports, setPorts] = useState<Forgotten[]>([]);
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [hooksReady, setHooksReady] = useState<boolean | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /* The open projects, once: where the scope starts when nobody chose. */
  useEffect(() => {
    api.projects().then((r) => {
      if (!live.current) return;
      setOpen(r.workspaces?.length ? r.workspaces : r.workspace ? [r.workspace] : []);
    }).catch(() => {});
  }, []);

  const projects = useMemo(() => pickerProjects(open, chairs.map((c) => c.root), rows ?? []), [open, chairs, rows]);
  /* A scope nobody chose follows the first open project; with none open it is every project. */
  const effective = scope === ALL ? ALL : scope && (projects.includes(scope) || scope.startsWith("/")) ? scope : open[0] ?? projects[0] ?? ALL;
  const setScope = useCallback((s: string) => { setScopeState(s); keepScope(s); }, []);

  const readSeat = useCallback(() => {
    if (effective === ALL) { setSeat(null); return; }
    api.seat(effective).then((r) => {
      if (!live.current) return;
      setSeat(r); setCheckedAt(Date.now()); setError(!r.ok && r.error ? r.error : "");
    }).catch(() => { if (live.current) setError("could not read the orchestrator"); });
  }, [effective]);
  const readPorts = useCallback(() => { api.machinePorts().then((r) => { if (live.current) setPorts(forgottenPorts(r.ports)); }).catch(() => {}); }, []);
  const readSchedules = useCallback(() => {
    api.agentSchedules().then((r) => { if (live.current && r.ok && r.result) setSchedules(r.result.schedules); }).catch(() => {});
  }, []);

  useEffect(() => { if (active) readSeat(); }, [active, readSeat]);
  useVisibleInterval(readSeat, 15_000, active);
  /* Asks arrive as `gate` and `settings-requests` frames (useLive.ts) into their own stores; this
     reads those stores, with one fetch on open and one on return to a hidden window instead of a
     5 s poll. A frame lost in a reconnect is caught by that return fetch. */
  useEffect(() => {
    if (!active) return;
    const sync = () => { if (live.current) { setGates(listGates()); setRequests([...settingsRequests.list()]); } };
    const fetchBoth = () => { void pollGatesNow(); void settingsRequestsChanged(); };
    const onShow = () => { if (!document.hidden) fetchBoth(); };
    sync(); fetchBoth();
    const a = subscribeGates(sync), b = settingsRequests.subscribe(sync);
    document.addEventListener("visibilitychange", onShow);
    return () => { a(); b(); document.removeEventListener("visibilitychange", onShow); };
  }, [active]);
  /* No server event for ports or schedules yet: polled, but only while visible. */
  useEffect(() => { if (active) { readPorts(); readSchedules(); } }, [active, readPorts, readSchedules]);
  useVisibleInterval(readPorts, 60_000, active);
  useVisibleInterval(readSchedules, 30_000, active);
  /* Read once per open: whether the screen can see agents at all (first-run step one). */
  useEffect(() => {
    if (!active) return;
    Promise.all([api.hooksStatus().catch(() => null), api.agentPanes().catch(() => null)])
      .then(([h, p]) => { if (live.current) setHooksReady(!!h?.installed && !!p?.ok); });
  }, [active]);

  /* A project's agents are the ones its `/seat` puts on its field; every
     project is the whole board. The field is the server's own scoping
     (worktrees fold into their project), so nothing is guessed here. */
  const scoped = useMemo(() => {
    const all = rows ?? [];
    if (effective === ALL) return all;
    if (!seat || seat.root !== effective) return [];
    const names = new Set(seat.field.map((f) => f.name));
    return all.filter((r) => names.has(r.name));
  }, [rows, effective, seat]);

  const forgotten = useMemo(
    () => (effective === ALL ? ports : ports.filter((f) => under(f.port.dir ?? f.port.cwd, effective))),
    [ports, effective],
  );

  const reload = useCallback(() => { void refreshLantern(); readSeat(); void pollGatesNow(); void settingsRequestsChanged(); readPorts(); readSchedules(); }, [readSeat, readPorts, readSchedules]);

  return {
    scope: effective, setScope, projects, rows, scoped, seat: effective === ALL ? null : seat, gates, requests, forgotten, schedules, hooksReady, checkedAt, error, reload,
  };
}
