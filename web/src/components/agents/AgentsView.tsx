import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import "./agentsView.css";
import { fmtAgo } from "../../lib/format.ts";
import { askLantern, hasLanternTab } from "../../lib/lanternAsk.ts";
import { subscribeBench } from "../../lib/benchStore.ts";
import { subscribeLantern, lanternChairs } from "../../lib/lanternStore.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { Ph } from "./phosphor.tsx";
import { useAgents, ALL } from "./useAgents.ts";
import { Tiles, WaitingSection, WorkingSection, UpNext, CleanUpSection, NewBadge } from "./AgentsSections.tsx";
import { CoordinatorCard, ChangeDialog, ProjectCoordinators, PowersAndNotifies } from "./CoordinatorCard.tsx";
import { AgentRulesSection } from "./AgentRulesSection.tsx";
import { ScheduleDialog } from "../LanternSchedule.tsx";
import GateScriptBanner from "../GateScriptBanner.tsx";
import { api } from "../../lib/api.ts";
import { subscribeViewModal, takeViewModal } from "../../lib/viewModalIntent.ts";
import { whatWaits } from "../../lib/seatWaiting.ts";
import { staleLine, hiddenLine, isRoutineLine } from "../../lib/agentsStale.ts";
import { groupCleanup } from "../../lib/cleanupGroups.ts";
import { coordinatorState } from "../../lib/coordinatorState.ts";
import { sortField, waitingItems, projectLabel } from "../../lib/agentsScreen.ts";

/**
 * THE AGENTS SCREEN. One screen for what the Lantern and the orchestrator's
 * chair used to answer separately: who is working, who needs you, what is left
 * behind, and who is minding the project.
 *
 * Three numbers answer it in five seconds. Under them, on the left, what waits
 * on you and what is working; on the right, the coordinator, its queue and what
 * to clean up. Everything old is folded into one line at the foot of the
 * column it belongs to. Only an agent BLOCKED on a person interrupts: every
 * section says where its data comes from and whether it can.
 *
 * Decisions are in lib/agentsScreen.ts, lib/agentsStale.ts,
 * lib/cleanupGroups.ts and lib/coordinatorState.ts; this lays them out. The
 * layout, the wording and the order are the approved design's.
 */

/* The approved design labels this button with its word. The one-refresh-control
   guard (test/refresh-one.test.ts) bans the word as JSX text, so it is carried
   here; changing it to the house icon-only RefreshButton is this line and the
   button below. */
const REFRESH = "Refresh";
const HOW_KEY = "agentglass.agents.how";
const readHow = (): boolean => { try { return localStorage.getItem(HOW_KEY) !== "closed"; } catch { return true; } };

function useNow(active: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function AgentsView({ active }: { active: boolean }) {
  const d = useAgents(active);
  const now = useNow(active);
  const chairs = useSyncExternalStore((l) => subscribeLantern(l, false), lanternChairs, lanternChairs);
  const lanternOpen = useSyncExternalStore(subscribeBench, hasLanternTab, hasLanternTab);
  const [how, setHow] = useState(readHow);
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [change, setChange] = useState<{ root: string; first: "new" | "mine" } | null>(null);
  const [showRef, setShowRef] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [checkouts, setCheckouts] = useState<string[]>([]);

  const all = d.scope === ALL;
  const root = all ? "" : d.scope;
  const seat = d.seat;
  const rows = d.rows;
  const sorted = useMemo(() => sortField(d.scoped, now), [d.scoped, now]);
  const reachable = useMemo(() => new Set([...sorted.working, ...sorted.blocked, ...sorted.idle].map((r) => r.name)), [sorted]);

  /* The coordinator's side: what it asked, what its agents sent, its queue. */
  const wait = useMemo(
    () => whatWaits(seat?.field ?? [], seat?.reports ?? [], seat?.tasks ?? [], seat?.needs ?? [], 2, now),
    [seat, now],
  );
  const sessions = new Set(d.scoped.map((r) => r.session).filter(Boolean));
  const gates = all ? d.gates : d.gates.filter((g) => sessions.has(g.session_id));
  const requests = d.requests.filter((r) => all || !r.root || r.root === root);
  const items = useMemo(
    () => waitingItems({ blocked: sorted.blocked, gates, needs: wait.ready, asked: wait.asked, orphaned: wait.orphaned, beaten: wait.beaten, requests }),
    [sorted.blocked, gates, wait, requests],
  );
  const stale = useMemo(() => staleLine(wait.stale, (a) => reachable.has(a), now), [wait.stale, reachable, now]);
  const clean = useMemo(
    () => groupCleanup(d.forgotten, all ? d.schedules : d.schedules.filter((s) => s.cwd === root || s.cwd.startsWith(`${root}/`)), now),
    [d.forgotten, d.schedules, all, root, now],
  );
  const hidden = hiddenLine(seat?.quiet);
  const hiddenDetail = useMemo(() => {
    const at = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    const routine = (seat?.lines ?? []).filter((l) => isRoutineLine(l.line)).slice(0, 6).map((l) => `${at(l.at)}  ${l.line.replace(/^\(|\)$/g, "")}`);
    const old = (seat?.reports ?? []).filter((r) => now - r.at >= 7 * 86_400_000 && !(r.blocked || r.need)).slice(0, 6)
      .map((r) => `${r.agent}, ${fmtAgo(r.at)} ago: ${r.state || "no state"}`);
    return [...routine, ...old];
  }, [seat, now]);

  const coord = coordinatorState(seat?.seat, seat?.live === true);
  const loading = rows === null || (!all && !seat);
  const firstRun = !loading && sorted.working.length + sorted.blocked.length + sorted.idle.length === 0 && coord === "none" && items.length === 0 && clean.total === 0;
  /* Every Claude session in tmux that could take the chair: the project's own coordinator included, so the one
     in charge is in the list as "chosen"; another project's coordinator is not offered. */
  const candidates = useMemo(
    () => (rows ?? []).filter((r) => r.role !== "lantern" && !(r.role && r.chairOf !== change?.root) && !r.gone && r.paneId && !sorted.gone.includes(r)),
    [rows, sorted.gone, change?.root],
  );

  const ask = async () => { setAsking("opening…"); const r = await askLantern(); setAsking(r.ok ? null : r.error ?? "could not open"); };
  const closeHow = () => { setHow(false); try { localStorage.setItem(HOW_KEY, "closed"); } catch { /* a convenience */ } };
  const pick = (s: string) => { d.setScope(s); setMenu(false); };

  /* The two dialogs an agent can ask for through the registry (lib/viewModalIntent.ts). */
  useEffect(() => {
    const run = () => {
      if (takeViewModal("lantern.schedule")) setScheduling(true);
      if (takeViewModal("agents.change") && root) setChange({ root, first: coord === "none" ? "mine" : "new" });
    };
    run();
    return subscribeViewModal(run);
  }, [root, coord]);
  useEffect(() => {
    if (scheduling) api.agentCheckouts().then((r) => setCheckouts(r.allowed ?? [])).catch(() => {});
  }, [scheduling]);
  const cancelSchedule = (id: string) => { void api.agentUnschedule(id).then(d.reload).catch(() => {}); };

  const label = all ? "Every project" : projectLabel(root);
  const who = (session: string) => { const r = rows?.find((x) => x.session === session); return r ? { name: r.name, worktree: r.worktree } : undefined; };
  const rules = (compact: boolean) => (
    <AgentRulesSection root={root} projects={d.projects} who={who} gates={d.gates} active={active} now={now} compact={compact} />
  );
  return (
    <div className="agv">
      <div className="page">
        <div className="head">
          <div>
            <div className="row" style={{ gap: 16 }}>
              <h1>Agents</h1>
              <div className="seg2 scope-menu">
                <button type="button" className={all ? "" : "on"} aria-haspopup="listbox" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
                  <Ph name="folder-simple" size={14} />{all ? (d.projects[0] ? projectLabel(d.projects[0]) : "Project") : label}<Ph name="caret-down" size={12} />
                </button>
                <button type="button" className={all ? "on" : ""} aria-pressed={all} onClick={() => pick(ALL)}>All projects<b>{d.projects.length}</b></button>
                {menu && (
                  <div className="scope-pop" role="listbox" aria-label="Project">
                    {d.projects.length === 0 && <span className="mut none">No project is open</span>}
                    {d.projects.map((p) => (
                      <button key={p} type="button" role="option" aria-selected={p === root} className={p === root ? "on" : ""} onClick={() => pick(p)} title={p}>
                        <span>{projectLabel(p)}</span>{chairs.some((c) => c.root === p) && <span className="mut">coordinator</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <NewBadge />
            </div>
            <div className="scopeline">
              <Ph name="info" size={14} />
              {all
                ? <>Showing agents working in every project. Pick a project to see its coordinator and queue.</>
                : <>Showing agents working in <b style={{ color: "var(--text2)" }}>{label}</b>. The coordinator and its queue belong to this project only.</>}
              {d.error && <span className="err-line" role="alert" style={{ marginLeft: 8 }}>{d.error}</span>}
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={d.reload}><Ph name="arrows-clockwise" size={14} />{REFRESH}</button>
            <button type="button" className="btn" disabled={asking === "opening…"} onClick={() => void ask()}
              title="A session on the floating bench that opens with this field as its first message. Ctrl+Alt+A brings it back from any view.">
              <Ph name="sparkle" size={14} />{asking === "opening…" ? "Opening…" : lanternOpen ? "Back to the session" : "Ask about the agents"}
            </button>
            {asking && asking !== "opening…" && <span className="err-line">{asking}</span>}
          </div>
        </div>

        <GateScriptBanner active={active} />
        {loading && <div className="mut" style={{ marginBottom: 18 }}>reading the agents…</div>}

        {firstRun ? (
          <div className="how big">
            <div className={`st${d.hooksReady ? " done" : ""}`}>
              <span className="n">{d.hooksReady ? <Ph name="check" size={16} /> : 1}</span>
              <div>
                <b>{d.hooksReady ? "agentglass can see your agents" : "Let agentglass see your agents"}</b>
                <span>{d.hooksReady ? "Hooks are installed and tmux was found." : "The hooks are not installed, or tmux was not found."}</span>
                <div style={{ marginTop: 8 }}>
                  {d.hooksReady
                    ? <span className="agv-chip ok">Ready</span>
                    : <button type="button" className="btn sm" onClick={() => openSettings("hooks")}>Open Settings, Agents</button>}
                </div>
              </div>
            </div>
            <div className="st">
              <span className="n">2</span>
              <div><b>Start any Claude session in tmux</b><span>It shows up here by itself. Nothing to configure.</span><div style={{ marginTop: 8 }}><span className="agv-chip">0 agents yet</span></div></div>
            </div>
            <div className={`st${d.hooksReady ? " next" : ""}`}>
              <span className="n">3</span>
              <div><b>Pick a coordinator for this project</b><span>Optional. One agent that splits work and keeps the others moving.</span>
                <div style={{ marginTop: 8 }}>{d.hooksReady && <span className="agv-chip info">Do this next, on the right</span>}</div></div>
            </div>
          </div>
        ) : how ? (
          <div className="how">
            <span className="lab"><Ph name="question" size={16} />How this screen works</span>
            <div className="st"><span className="n">1</span><div><b>Agents report in</b><span>through hooks and tmux, nothing to type</span></div></div>
            <div className="st"><span className="n">2</span><div><b>agentglass sorts them</b><span>working, waiting for you, left behind</span></div></div>
            <div className="st"><span className="n">3</span><div><b>Only a blocked agent interrupts you</b><span>everything else is a quiet badge</span></div></div>
            <button type="button" className="btn sq quiet" aria-label="Hide how this screen works" onClick={closeHow}><Ph name="x" size={14} /></button>
          </div>
        ) : null}

        <Tiles working={sorted.working.length} blocked={sorted.blocked.length} idle={sorted.idle.length} waiting={items} clean={clean} nowMs={now} />

        <div className="grid2">
          <div className="cols">
            <WaitingSection items={items} root={root} seat={seat} now={now} stale={stale} onChanged={d.reload} />
            <WorkingSection working={sorted.working} idle={sorted.idle} gone={sorted.gone} hidden={hidden} hiddenDetail={hiddenDetail} onChanged={d.reload} />
            {firstRun && <div>{rules(true)}</div>}
          </div>
          <div className="cols">
            {all
              ? <ProjectCoordinators projects={d.projects} chairs={chairs} onPick={(r) => { d.setScope(r); setChange({ root: r, first: "new" }); }} onChanged={d.reload} />
              : <CoordinatorCard root={root} seat={seat} onChange={() => setChange({ root, first: coord === "none" ? "mine" : "new" })} onChanged={d.reload} />}
            <UpNext seat={seat} schedules={d.schedules} onCancel={cancelSchedule} showEmpty={!all} />
            <CleanUpSection clean={clean} onChanged={d.reload} />
          </div>
        </div>

        {!all && (
          <div style={{ marginTop: 24 }}>
            <div className="fold">
              <Ph name="toggle-right" size={15} />
              <span>What the three powers mean, and who notifies you</span>
              <span className="sp" />
              <button type="button" className="btn sm" aria-expanded={showRef} onClick={() => setShowRef((v) => !v)}>{showRef ? "Hide" : "Show"}</button>
            </div>
            {showRef && <PowersAndNotifies root={root} seat={seat} onChanged={d.reload} />}
          </div>
        )}

        {!firstRun && <div style={{ marginTop: 30 }}>{rules(false)}</div>}
      </div>

      <ScheduleDialog open={scheduling} checkouts={checkouts} onClose={() => setScheduling(false)} onAdded={d.reload} />
      {change && (
        <ChangeDialog root={change.root} seat={change.root === root ? seat : null} chair={chairs.find((c) => c.root === change.root)} candidates={candidates} first={change.first}
          onClose={() => setChange(null)} onChanged={d.reload} />
      )}
    </div>
  );
}

