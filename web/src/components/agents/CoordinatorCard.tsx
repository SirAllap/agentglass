import { useEffect, useState } from "react";
import { api, type SeatAnswer } from "../../lib/api.ts";
import { fmtAgo } from "../../lib/format.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { Ph } from "./phosphor.tsx";
import { NewBadge, SectionHead, SubLine } from "./AgentsSections.tsx";
import { coordinatorState, powersOn, levelAfterToggle, wakeTicks, nextLook, type PowerId } from "../../lib/coordinatorState.ts";
import { isRoutineLine } from "../../lib/agentsStale.ts";
import { projectLabel, ageShort } from "../../lib/agentsScreen.ts";
import type { LanternRow, LanternChair } from "../LanternView.tsx";
import { choiceLabel } from "../../../../shared/orchestration.ts";

/*
 * THE COORDINATOR — one card, three states, and the way to change who it is.
 *
 * One coordinator per project and nothing ranks them. The card is the same
 * block in all three states (none, on duty, stood down) so nothing moves when
 * the state does. "Use one of my sessions" is the screen for POST /seat/adopt
 * (adoptSeat), which existed with no door for a person: a session that is
 * already running and already has agents reporting to it becomes the
 * coordinator without being thrown away.
 */

const POWER_WORDS: Record<PowerId, { label: string; what: string }> = {
  speak: { label: "Speaks", what: "Reads the field and reports. Touches no agent." },
  nudge: { label: "Unsticks", what: "Can prompt an agent that is already running." },
  assign: { label: "Assigns", what: "Can prompt, start and stop named agents." },
};

/** A busy-guarded call whose failure is a sentence, not a silence. */
function useDo(onChanged: () => void) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(what); setErr("");
    let ok = false;
    try { const r = await fn(); ok = r.ok; if (!r.ok) setErr(r.error ?? "that did not go through"); } catch { setErr("that did not go through"); }
    setBusy(""); onChanged();
    return ok;
  };
  return { busy, err, run };
}

export function CoordinatorCard({ root, seat, polaris, onChange, onChanged }: { root: string; seat: SeatAnswer | null; /** "Polaris, Guided": shown while Polaris is on for this project. */ polaris?: string | null; onChange: () => void; onChanged: () => void }) {
  const { busy, err, run } = useDo(onChanged);
  const state = coordinatorState(seat?.seat, seat?.live === true);
  const keptKey = `agentglass.agents.keptDown:${root}`;
  const [kept, setKept] = useState(() => { try { return localStorage.getItem(keptKey) === "1"; } catch { return false; } });
  const keepDown = (v: boolean) => {
    setKept(v);
    try { if (v) localStorage.setItem(keptKey, "1"); else localStorage.removeItem(keptKey); } catch { /* a convenience */ }
  };
  const label = projectLabel(root);
  const row = seat?.seat;
  const adopted = !!row?.adoptedPane;
  const name = seat?.agent?.name || row?.name || "orchestrator";
  const hint = state === "none" ? undefined : "last 24 h";

  const start = () => void run("start", async () => { const r = await api.seatOpen(root); if (r.ok) keepDown(false); return r; });

  if (state === "none" || (state === "stood-down" && kept)) {
    return (
      <div>
        <SectionHead title="Coordinator" hint={hint} />
        <SubLine src="from the orchestrator" icon="robot" notify="quiet" />
        <div className="ccta">
          <div className="row" style={{ gap: 12 }}>
            <span className="eb-lg"><Ph name="compass" size={22} /></span>
            <div><div className="big">No orchestrator for {label}</div><p>Nobody is splitting the work or watching the others.</p></div>
          </div>
          <button type="button" className="btn primary" style={{ height: 38, fontSize: 14, padding: "0 18px" }} disabled={!!busy || !root} onClick={start}>
            <Ph name="rocket-launch" size={16} />{busy === "start" ? "Starting…" : "Start an orchestrator"}
          </button>
          <button type="button" className="link" style={{ fontSize: 12.5 }} onClick={onChange}><Ph name="user-switch" size={14} />Already run an orchestrator session? Use it <NewBadge /></button>
          {err && <div className="err-line" role="alert">{err}</div>}
        </div>
      </div>
    );
  }

  if (state === "stood-down") {
    return (
      <div>
        <SectionHead title="Coordinator" hint={hint} />
        <SubLine src="from the orchestrator" icon="robot" notify="quiet" />
        <div className="card stc">
          <div className="row" style={{ gap: 10 }}><span className="agv-chip warn">Stood down</span><b>{name}</b></div>
          <div className="mut" style={{ fontSize: 12.5, fontFamily: "var(--font-prose)" }}>
            It no longer wakes or messages agents. {adopted ? "The tmux session still runs, it is just not the orchestrator." : "Its tmux window was closed."}
          </div>
          <div className="row">
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={start}><Ph name="rocket-launch" size={14} />{busy === "start" ? "Seating…" : "Seat an orchestrator"}</button>
            <button type="button" className="btn sm" onClick={() => keepDown(true)}>Keep stood down</button>
          </div>
          {err && <div className="err-line" role="alert">{err}</div>}
        </div>
      </div>
    );
  }

  const chosen = row?.model || seat?.defaultModel || "";
  const model = chosen ? seat?.models.find((m) => m.id === chosen)?.label ?? chosen : "";
  const ticks = wakeTicks(seat?.lines ?? [], Date.now(), isRoutineLine);
  const next = nextLook(seat?.wokenAt ?? null, seat?.floorHours ?? 4);
  const pane = seat?.agent?.paneId || row?.adoptedPane;
  return (
    <div>
      <SectionHead title="Coordinator" hint={hint} />
      <SubLine src="from the orchestrator" icon="robot" notify="quiet" />
      <div className="card coord">
        <div className="h">
          <span className="badge"><Ph name="compass" size={20} /></span>
          <div><b>{name}</b><div className="mut" style={{ fontSize: 11.5 }}>for {label}</div></div>
          <span className="agv-chip ok" style={{ marginLeft: 6 }}><span className="dot" style={{ width: 7, height: 7 }} />On duty</span>
          <span className="sp" />
          <button type="button" className="btn sm" disabled={!!busy} title="Empty the chair. Its rules and settings are kept."
            onClick={() => void run("close", () => api.seatClose(root))}>{busy === "close" ? "Standing down…" : "Stand down"}</button>
        </div>
        <div className="sess">
          {pane && <span className="agv-chip line"><Ph name="terminal-window" size={13} />tmux {pane}</span>}
          {adopted && <span className="agv-chip info"><Ph name="user-circle" size={13} />your own session</span>}
          {model && <span className="agv-chip line">{model}</span>}
          {polaris && <span className="agv-chip info" title="The pull request abilities of this orchestrator. Settings, Orchestration changes them."><Ph name="compass" size={13} />{polaris}</span>}
        </div>
        <div className="ticks">
          {ticks.map((t, i) => <div className="tick" key={i}><i className={t.kind === "empty" ? "" : t.kind} />{t.label}</div>)}
        </div>
        <div className="next" title={seat?.wokenAt ? `Woken ${fmtAgo(seat.wokenAt)} ago` : "Not woken since it sat down"}>
          <Ph name="clock" size={14} />
          <div className="meter"><i style={{ width: `${next.pct}%` }} /></div>
          <span><b>{next.left}</b> to next look</span>
        </div>
        <div className="pwr">
          {powersOn(row?.powers ?? "speak").map((p) => (
            <span key={p.id} className={`pw${p.on ? "" : " off"}`} title={POWER_WORDS[p.id].what}>{p.on && <Ph name="check" size={12} />}{p.label}</span>
          ))}
        </div>
        <div className="cfoot">
          <button type="button" className="link" onClick={() => openSettings("lantern")}><Ph name="gear" size={14} />Settings, Agents</button>
          <button type="button" className="btn sm" onClick={onChange}><Ph name="user-switch" size={14} />Change</button>
        </div>
        {err && <div className="err-line" role="alert">{err}</div>}
      </div>
    </div>
  );
}

/* ── change ───────────────────────────────────────────────────────────── */

const home = (p: string) => p.replace(/^\/home\/[^/]+\//, "~/");

export function ChangeDialog({ root, seat, chair, candidates, first, onClose, onChanged }: {
  root: string; seat: SeatAnswer | null; chair?: LanternChair; candidates: LanternRow[]; first: "new" | "mine"; onClose: () => void; onChanged: () => void;
}) {
  const { busy, err, run } = useDo(onChanged);
  const current = seat?.seat?.adoptedPane ?? "";
  const [mode, setMode] = useState<"new" | "mine">(current ? "mine" : first);
  const [pick, setPick] = useState(current);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const live = seat?.live === true;
  const chosen = candidates.find((c) => c.paneId === pick);
  const go = async () => {
    const ok = await run("go", async () => {
      /* The policy names another engine for the chair and its hand-off is written:
         "new" means that one, through the route that seats it. */
      if (mode === "new" && live && chair?.next && chair.handedOff) return api.seatChange(root);
      /* adoptSeat refuses a second pane in the chair, so a live one stands down first. */
      if (live && !(mode === "mine" && pick === current)) {
        const c = await api.seatClose(root);
        if (!c.ok) return { ok: false, error: "could not stand the current orchestrator down" };
      }
      return mode === "new" ? api.seatOpen(root) : api.seatAdopt(root, chosen?.session ?? "", pick);
    });
    if (ok) onClose();
  };
  const stateOf = (r: LanternRow) => {
    if (r.state === "working") return <span className="agv-chip info">working</span>;
    const at = r.saidAt ?? r.facts?.lastSeen;
    const ms = at ? Date.now() - at : 0;
    return <span className={`agv-chip${ms < 3_600_000 ? " ok" : ""}`}>idle {at ? ageShort(ms) : ""}</span>;
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Change the orchestrator" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pop">
        <div className={`opt${mode === "new" ? " on" : ""}`} onClick={() => setMode("new")}>
          <span className={`radio${mode === "new" ? " on" : ""}`} role="radio" aria-checked={mode === "new"} />
          <div><b><Ph name="rocket-launch" size={16} />Start a new orchestrator</b><small>agentglass opens a tmux window and seats it. Its powers are enforced.</small>
            {live && chair?.next && (
              <small style={{ marginTop: 6 }}>
                Next in the chair: <b style={{ display: "inline" }}>{choiceLabel(chair.next)}</b>, when you say so.{!chair.handedOff && ` ${chair.name} has not written its hand-off yet.`}
              </small>
            )}</div>
        </div>
        <div className={`opt${mode === "mine" ? " on" : ""}`} onClick={() => setMode("mine")}>
          <span className={`radio${mode === "mine" ? " on" : ""}`} role="radio" aria-checked={mode === "mine"} />
          <div>
            <b><Ph name="user-switch" size={16} />Use one of my sessions <NewBadge /></b>
            <small>Pick a Claude session you already run in tmux for this project.</small>
            {candidates.length === 0 && <small style={{ marginTop: 8 }}>No Claude session is running in tmux right now.</small>}
            {[...candidates].sort((a, b) => Number(b.paneId === current) - Number(a.paneId === current)).map((c) => (
              <button key={c.paneId} type="button" className={`sl${pick === c.paneId ? " on" : ""}`}
                onClick={(e) => { e.stopPropagation(); setMode("mine"); setPick(c.paneId!); }}>
                <span><b>{c.name}</b> <span className="mut">{c.paneId}{c.worktree ? `, ${home(c.worktree)}` : ""}</span></span>
                {stateOf(c)}
                <span className="mut">{pick === c.paneId ? "chosen" : "pick"}</span>
              </button>
            ))}
            <small style={{ marginTop: 8 }}>The session keeps running when you stand it down. Its powers are told to it, not enforced.</small>
          </div>
        </div>
        {err && <div className="err-line" role="alert" style={{ padding: "0 12px 6px" }}>{err}</div>}
        <div className="pop-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!!busy || !root || (mode === "mine" && !chosen)} onClick={() => void go()}>
            {busy ? "Working…" : mode === "mine" ? "Make it the orchestrator" : "Start an orchestrator"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── one coordinator per project ──────────────────────────────────────── */

export function ProjectCoordinators({ projects, chairs, onPick, onChanged }: {
  projects: string[]; chairs: LanternChair[]; onPick: (root: string) => void; onChanged: () => void;
}) {
  const { busy, err, run } = useDo(onChanged);
  const roots = [...new Set([...projects, ...chairs.map((c) => c.root)])];
  return (
    <div>
      <SectionHead title="Coordinator" />
      <SubLine src="from the orchestrator" icon="robot" notify="quiet" />
      <div className="card">
        {roots.length === 0 && <div className="pj"><div><b>No project is open</b><small>Open a project to give it an orchestrator.</small></div></div>}
        {roots.map((root) => {
          const c = chairs.find((x) => x.root === root);
          return (
            <div className="pj" key={root}>
              <div><b>{projectLabel(root)}</b><small>{c ? `${c.name}, ${c.adopted ? "your own session" : "started by agentglass"}` : "no orchestrator"}</small></div>
              <span className={`agv-chip${c ? " ok" : ""}`}>{c ? "On duty" : "None"}</span>
              {c
                ? <button type="button" className="btn sm" onClick={() => onPick(root)}>Change</button>
                : <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => void run(root, () => api.seatOpen(root))}>{busy === root ? "Starting…" : "Start"}</button>}
            </div>
          );
        })}
      </div>
      {err && <div className="err-line" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      <div className="fold" style={{ marginTop: 10 }}>
        <Ph name="info" size={14} />
        <span>Nothing ranks them. Each orchestrator runs only its own project. Picking the project to look at is <NewBadge />.</span>
      </div>
    </div>
  );
}

/* ── the three powers, and who notifies you ───────────────────────────── */

export function PowersAndNotifies({ root, seat, onChanged }: { root: string; seat: SeatAnswer | null; onChanged: () => void }) {
  const { busy, err, run } = useDo(onChanged);
  const level = seat?.seat?.powers ?? "speak";
  const adopted = !!seat?.seat?.adoptedPane && seat.live;
  const notifies: [string, string, string | null, "now" | "quiet"][] = [
    ["lock-key", "An agent blocked on you", "permission, a question, a rule to loosen", "now"],
    ["terminal-window", "An agent working or idle", null, "quiet"],
    ["compass", "The orchestrator's report or question", null, "quiet"],
    ["hard-drives", "A forgotten server, a dead schedule", null, "quiet"],
  ];
  return (
    <div className="refbox">
      <div>
        <h2 className="pg">What the three powers mean</h2>
        <div className="card">
          {(["speak", "nudge", "assign"] as const).map((id) => {
            const on = powersOn(level).find((p) => p.id === id)!.on;
            return (
              <div className="pwrow" key={id}>
                <div><b>{POWER_WORDS[id].label}</b><small>{POWER_WORDS[id].what}</small></div>
                <button type="button" className={`sw${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={POWER_WORDS[id].label}
                  disabled={!!busy || !root || id === "speak"}
                  title={id === "speak" ? "An orchestrator always reads and reports" : adopted ? "Told to the session, not enforced: it was already running" : "Enforced by the server; applies at the next seating"}
                  onClick={() => void run(id, () => api.seatSettingsSave(root, { powers: levelAfterToggle(level, id) }))} />
              </div>
            );
          })}
        </div>
        {err && <div className="err-line" role="alert" style={{ marginTop: 8 }}>{err}</div>}
        <div className="cfoot" style={{ border: 0, padding: "12px 2px 0" }}>
          <button type="button" className="crumb" onClick={() => openSettings("lantern")}><Ph name="gear" size={14} />Settings<Ph name="caret-down" size={12} />Agents<Ph name="caret-down" size={12} />Lantern</button>
        </div>
      </div>
      <div>
        <h2 className="pg">Who notifies you</h2>
        <div className="card">
          <table className="ntab"><tbody>
            {notifies.map(([icon, title, sub, kind]) => (
              <tr key={title}>
                <td><Ph name={icon as never} size={16} /></td>
                <td><b>{title}</b>{sub && <div className="mut">{sub}</div>}</td>
                <td><span className={`nf ${kind}`}><Ph name={kind === "now" ? "bell-ringing" : "bell-simple-slash"} size={13} />{kind === "now" ? "Notifies you" : "Quiet badge"}</span></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </div>
  );
}
