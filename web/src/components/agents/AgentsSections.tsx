import { useState, type ReactNode } from "react";
import { api, type SeatAnswer } from "../../lib/api.ts";
import { fmtAgo } from "../../lib/format.ts";
import { jumpToPane } from "../../lib/paneJump.ts";
import { Ph, type PhName } from "./phosphor.tsx";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import {
  ageWord, agePct, ageShort, doingVerb, askLine, matchFor, ruleTitleOf, spendPct, dollars,
  squares, waitingMini, toneOfWait, type WaitItem,
} from "../../lib/agentsScreen.ts";
import { stackShares, isDeadSchedule, type CleanGroup, type CleanKind } from "../../lib/cleanupGroups.ts";
import type { AgentSchedule } from "../LanternSchedule.tsx";
import type { StaleLine } from "../../lib/agentsStale.ts";
import type { LanternRow } from "../LanternView.tsx";

/*
 * THE SECTIONS OF THE AGENTS SCREEN, drawn from decisions made in
 * lib/agentsScreen.ts, lib/cleanupGroups.ts and lib/agentsStale.ts.
 *
 * Every control here is a call to a route that already exists (the gate's
 * decide, the settings request's decide, the seat's need/finish, the machine's
 * kill, the schedule's cancel) and none of them is drawn when it has nothing to
 * call: a held call with no gate behind it gets "Open terminal" and nothing
 * pretending to be an Allow.
 */

export const NewBadge = () => <span className="new">new</span>;

export function SectionHead({ title, count, tone, hint, children }: { title: string; count?: number; tone?: "err" | "ok" | "warn"; hint?: string; children?: ReactNode }) {
  return (
    <div className="sh">
      <h2>{title}</h2>
      {count !== undefined && <span className={`cnt${count > 0 && tone ? ` ${tone}` : ""}`}>{count}</span>}
      <span className="sp" />
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}

/** Where a section's data comes from, and whether it can interrupt you. `notifyText` is the section's own sentence when "Notifies you" is not the whole of it. */
export function SubLine({ src, icon, notify, notifyText }: { src: string; icon: PhName; notify?: "now" | "quiet"; notifyText?: string }) {
  return (
    <div className="subline">
      <span className="src"><Ph name={icon} size={13} />{src}</span>
      {notify && (
        <span className={`nf ${notify}`}>
          <Ph name={notify === "now" ? "bell-ringing" : "bell-simple-slash"} size={13} />{notifyText ?? (notify === "now" ? "Notifies you" : "Quiet badge")}
        </span>
      )}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: PhName; title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="eb"><Ph name={icon} size={20} /></span>
      <div><b>{title}</b>{children}</div>
    </div>
  );
}

/* ── the three big cards ──────────────────────────────────────────────── */

export function Tiles({ working, blocked, idle, waiting, clean, nowMs }: {
  working: number; blocked: number; idle: number; waiting: WaitItem[]; clean: { groups: CleanGroup[]; total: number }; nowMs: number;
}) {
  const total = working + blocked + idle;
  const sq = squares({ working, blocked, idle });
  const mini = waitingMini(waiting, nowMs);
  const stack = stackShares(clean.groups);
  const shade: Record<CleanKind, string> = { "left-behind": "var(--agv-clean-1)", duplicates: "var(--agv-clean-2)", idle: "var(--agv-clean-2)", schedule: "var(--agv-clean-3)" };
  const legend: [CleanKind, string][] = [["left-behind", "left behind"], ["duplicates", "copies"], ["idle", "idle"], ["schedule", "schedule"]];
  return (
    <div className="tiles">
      <div className={`agv-tile w${total === 0 ? " z" : ""}`}>
        <div className="num">{working}</div>
        <div>
          <div className="lab">working</div>
          <div className="squares">{sq.kinds.map((k, i) => <i key={i} className={k === "i" ? "" : k} />)}</div>
          {total === 0
            ? <div className="leg">no agents yet</div>
            : (
              <div className="leg">
                <span><u style={{ background: "var(--success)" }} />working</span>
                <span><u style={{ background: "var(--error)" }} />blocked</span>
                <span><u style={{ background: "var(--bg4)" }} />idle{sq.more > 0 ? ` +${sq.more}` : ""}</span>
              </div>
            )}
        </div>
      </div>
      <div className={`agv-tile n${waiting.length === 0 ? " z" : ""}`}>
        <div className="num">{waiting.length}</div>
        <div>
          <div className="lab">waiting on you</div>
          {mini.length === 0
            ? <div className="leg">nothing is blocked on you</div>
            : mini.map((m, i) => (
              <div className="mini" key={i}>
                <span title={m.name}>{m.name}</span>
                <div className="meter"><i style={{ width: `${m.pct}%`, background: m.tone === "err" ? "var(--error)" : "var(--warning)" }} /></div>
                <span>{m.age}</span>
              </div>
            ))}
        </div>
      </div>
      <div className={`agv-tile c${clean.total === 0 ? " z" : ""}`}>
        <div className="num">{clean.total}</div>
        <div>
          <div className="lab">to clean up</div>
          {stack.length === 0
            ? (
              <>
                <div className="stack"><i style={{ width: "100%", background: "var(--bg3)" }} /></div>
                <div className="leg lead">nothing left running</div>
              </>
            )
            : (
              <>
                <div className="stack">{stack.map((s) => <i key={s.kind} style={{ width: `${s.pct}%`, background: shade[s.kind] }} />)}</div>
                <div className="leg lead">
                  {legend.filter(([k]) => stack.some((s) => s.kind === k)).map(([k, word]) => (
                    <span key={k}><u style={{ background: shade[k] }} /><b>{stack.find((s) => s.kind === k)!.count}</b>{word}</span>
                  ))}
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  );
}

/* ── waiting on you ───────────────────────────────────────────────────── */

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const settingWord = (s: string) => (s === "ask" ? "Ask me" : s === "no rule" ? "No rule" : cap(s));

/** The coordinator's question: the last sentence that ends in "?" is the question, and is set in bold. */
function Question({ text }: { text: string }) {
  const m = /^(.*?)([^.!?]*\?)\s*$/s.exec(text.trim());
  if (!m || !m[2]) return <>{text}</>;
  return <>{m[1]}<b>{m[2].trim()}</b></>;
}

function AgeBar({ since, tone, now }: { since: number; tone: "err" | "warn"; now: number }) {
  const c = tone === "err" ? "var(--error)" : "var(--warning)";
  return (
    <div className="agebar" title={new Date(since).toLocaleString()}>
      <span style={{ color: c }}>{ageWord(now - since)}</span>
      <div className="meter"><i style={{ width: `${agePct(now - since)}%`, background: c }} /></div>
    </div>
  );
}

function WaitCard({ item, root, seat, now, onChanged }: { item: WaitItem; root: string; seat: SeatAnswer | null; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const tone = toneOfWait(item.kind);
  const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(what); setErr("");
    try { const r = await fn(); if (!r.ok) setErr(r.error ?? "that did not go through"); } catch { setErr("that did not go through"); }
    setBusy(""); onChanged();
  };
  const head = (icon: PhName, name: string, extra?: ReactNode) => (
    <div className="t">
      <span className="badge"><Ph name={icon} size={18} /></span><b>{name}</b>{extra}
      <span className="sp" /><AgeBar since={item.since} tone={tone} now={now} />
    </div>
  );
  const problem = err ? <div className="err-line" role="alert">{err}</div> : null;

  if (item.kind === "permission") {
    const g = item.gate;
    const ask = g ? askLine(g.tool, g.summary) : null;
    const ruleRoot = item.worktree || root;
    return (
      <div className="card ask"><div className="rail" /><div className="in">
        {head("lock-key", item.name, item.branch ? <span className="agv-chip line"><Ph name="git-branch" size={13} />{item.branch}</span> : null)}
        <div className="what">
          {ask
            ? <>{ask.verb} <span className="code">{ask.target || g!.tool}</span><span style={{ marginLeft: -8 }}>?</span></>
            : <>{item.why || "needs your permission"}</>}
        </div>
        <div className="acts">
          {g && (
            <button type="button" className="btn primary" disabled={!!busy}
              onClick={() => void run("once", () => api.gateDecide(g.id, "allow"))}><Ph name="check" size={14} />Allow once</button>
          )}
          {g && ruleRoot && (
            <button type="button" className="btn" disabled={!!busy}
              title="Allow this call, and make it a rule for this project"
              onClick={() => void run("always", async () => {
                /* The rule first, then the allow: a rule that fails to save must
                   not leave the person believing the habit was taught. */
                const w = await api.agentRuleSet({ root: ruleRoot, match: matchFor(g.tool, g.summary), setting: "allow", source: "always-allow" });
                if (!w.ok) return w;
                return api.gateDecide(g.id, "allow");
              })}>Always allow here</button>
          )}
          {item.paneId && (
            <button type="button" className="btn quiet" onClick={() => jumpToPane(item.paneId!)}><Ph name="terminal-window" size={14} />Open terminal</button>
          )}
        </div>
        {problem}
      </div></div>
    );
  }

  if (item.kind === "coordinator") {
    const n = item.need;
    const settle = (outcome: string) => run("settle", () => api.seatNeedSettled(root, n.id, outcome));
    return (
      <div className="card ask q"><div className="rail" /><div className="in">
        {head("chat-circle-text", "Coordinator")}
        <div className="what"><Question text={n.text} /></div>
        {(n.cost || n.proof) && <div className="mut" style={{ fontSize: 12 }}>{[n.cost && `costs ${n.cost}`, n.proof && `settled when ${n.proof}`].filter(Boolean).join(" · ")}</div>}
        <div className="acts">
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void settle(n.recommend)}>
            <Ph name={n.recommend ? "star" : "check"} size={14} />{n.recommend ? cap(n.recommend) : "Done"}
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void settle("no longer matters")}>Not needed</button>
          <button type="button" className="btn quiet" disabled={!!busy || !seat?.agent} onClick={() => setReplying((v) => !v)}>Reply</button>
          {n.recommend && <span className="rec"><Ph name="star" size={12} />recommended: {n.recommend}</span>}
        </div>
        {replying && seat?.agent && (
          <form className="reply" onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            void run("reply", async () => {
              const r = await api.agentsBroadcast(t, [seat.agent!.name]);
              const sent = r.result?.sent.some((x) => x.outcome === "sent" || x.outcome === "queued");
              /* `missing`: the route types only into agents agentglass started. An adopted session is the person's own, so the answer goes in its terminal. */
              if (!r.ok || !sent) return { ok: false, error: r.error ?? (r.result?.missing.length ? "agentglass types only into agents it started, and this coordinator is your own session: answer it in its terminal" : "the coordinator's window did not take it") };
              const s = await api.seatNeedSettled(root, n.id, `answered: ${t}`);
              if (s.ok) { setText(""); setReplying(false); }
              return s;
            });
          }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer the coordinator" aria-label="Answer the coordinator" className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
            <button type="submit" className="btn" disabled={!text.trim() || !!busy}>Send</button>
          </form>
        )}
        {problem}
      </div></div>
    );
  }

  if (item.kind === "rule") {
    const r = item.request;
    const d = item.diff;
    return (
      <div className="card ask q"><div className="rail" /><div className="in">
        {head("lock-key", item.name, <span className="agv-chip warn">{d ? "asks to loosen a rule" : "asks to change a setting"}</span>)}
        <div className="what">
          {d
            ? <>Allow <b>{ruleTitleOf(d.match)}</b><span style={{ marginLeft: -8 }}>?</span> <span className="mut" style={{ fontSize: 13 }}>Now: {settingWord(d.from)}. Loosening waits for your click.</span></>
            : <>Allow <b>{r.label}</b><span style={{ marginLeft: -8 }}>?</span> <span className="mut" style={{ fontSize: 13 }}>{r.diff[0] ?? ""}</span></>}
        </div>
        <div className="acts">
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run("allow", () => api.settingsRequestDecide(r.id, true))}><Ph name="check" size={14} />Allow</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void run("keep", () => api.settingsRequestDecide(r.id, false))}>{d ? `Keep ${settingWord(d.from)}` : "Decline"}</button>
          <span className="sp" />
          {d && <span className="nf now"><Ph name="bell-ringing" size={13} />Notified you</span>}
        </div>
        {problem}
      </div></div>
    );
  }

  if (item.kind === "report") {
    return (
      <div className="card ask q"><div className="rail" /><div className="in">
        {head("warning-circle", item.name)}
        <div className="what">{item.text}</div>
        {item.paneId && (
          <div className="acts"><button type="button" className="btn quiet" onClick={() => jumpToPane(item.paneId!)}><Ph name="terminal-window" size={14} />Open terminal</button></div>
        )}
      </div></div>
    );
  }

  const t = item.task;
  return (
    <div className="card ask q"><div className="rail" /><div className="in">
      {head("warning-circle", "Queue")}
      <div className="what">{t.title} <span className="mut" style={{ fontSize: 13 }}>has beaten {t.attempts} agents. A third go is not the answer.</span></div>
      <div className="acts"><button type="button" className="btn" disabled={!!busy} onClick={() => void run("drop", () => api.seatTaskDrop(root, t.id))}>Drop it</button></div>
      {problem}
    </div></div>
  );
}

export function WaitingSection({ items, root, seat, now, stale, onChanged }: {
  items: WaitItem[]; root: string; seat: SeatAnswer | null; now: number; stale: StaleLine | null; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const blockedNow = items.some((i) => i.kind === "permission");
  const dismissAll = async () => {
    if (!stale) return;
    setBusy(true); setErr("");
    try {
      const results = await Promise.all([
        stale.reportIds.length ? api.seatReportDismiss(root, stale.reportIds) : Promise.resolve({ ok: true }),
        ...stale.needIds.map((id) => api.seatNeedSettled(root, id, "stale, dismissed")),
      ]);
      const bad = results.find((r) => !r.ok) as { error?: string } | undefined;
      if (bad) setErr(bad.error ?? "could not dismiss them");
    } catch { setErr("could not dismiss them"); }
    setBusy(false); onChanged();
  };
  return (
    <div>
      <SectionHead title="Waiting on you" count={items.length} tone={blockedNow ? "err" : "warn"} />
      <SubLine src="from agent hooks" icon="plugs-connected" notify="now" />
      {items.length === 0
        ? <Empty icon="check-circle" title="Nothing is blocked on you">When an agent needs a permission, it shows here and notifies you. Nothing else does.</Empty>
        : items.map((i) => <WaitCard key={i.key} item={i} root={root} seat={seat} now={now} onChanged={onChanged} />)}
      {stale && (
        <div className="fold">
          <Ph name="eye-slash" size={15} /><b>{stale.count} stale</b>
          <span>oldest {stale.oldestDays} d{stale.agentsGone ? ", agents gone" : ""}</span>
          <span className="sp" />
          {err && <span className="err-line" role="alert">{err}</span>}
          <span className="nf quiet"><Ph name="bell-simple-slash" size={13} />Quiet badge</span>
          <button type="button" className="btn sm" disabled={busy || !root} onClick={() => void dismissAll()}>Dismiss all</button>
        </div>
      )}
    </div>
  );
}

/* ── working ──────────────────────────────────────────────────────────── */

function AgentRow({ r, spend, idle }: { r: LanternRow; spend: number[]; idle?: boolean }) {
  const tool = r.facts?.lastTool;
  const verb = doingVerb(tool?.name);
  const target = tool?.what || r.doing || "";
  const pulse = r.pulse ?? [];
  const max = Math.max(4, ...pulse);
  const seen = r.saidAt ?? tool?.at ?? r.facts?.lastSeen;
  const cost = r.facts?.cost ?? 0;
  const go = () => { if (r.paneId) jumpToPane(r.paneId); };
  return (
    <div className="ag" style={r.paneId ? { cursor: "pointer" } : undefined} title={r.paneId ? `Go to ${r.paneId}` : undefined}
      role={r.paneId ? "button" : undefined} tabIndex={r.paneId ? 0 : undefined}
      onClick={go} onKeyDown={(e) => { if (r.paneId && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(); } }}>
      <div className="nm"><span className={`dot${idle ? " idle" : ""}`} /><span title={r.name}>{r.name}</span></div>
      <div className="act">
        {verb
          ? <><span className="v"><Ph name={verb.icon} size={14} />{verb.word}</span><span className="tg" title={target}>{target}</span></>
          : <span className="tg" title={target}>{target || "no word yet"}</span>}
      </div>
      <div className="br">{r.branch ? <><Ph name="git-branch" size={14} /><span title={r.branch}>{r.branch}</span></> : null}</div>
      <div className="pulse" title={pulse.length ? `${pulse.reduce((a, b) => a + b, 0)} tool calls in the last hour` : "no reading of the last hour"}>
        {(pulse.length ? pulse : Array.from({ length: 12 }, () => 0)).map((n, i) => (
          <i key={i} style={{ height: Math.max(2, Math.round((n / max) * 18)), background: n > 0 ? undefined : "var(--bg4)" }} />
        ))}
      </div>
      <div className="cost">
        {cost > 0 ? <><span>{dollars(cost)}</span><div className="meter"><i style={{ width: `${spendPct(cost, spend)}%` }} /></div></> : <span className="mut">–</span>}
      </div>
      <div className="t mut">{seen ? fmtAgo(seen) : ""}</div>
    </div>
  );
}

function Table({ rows, spend, idle }: { rows: LanternRow[]; spend: number[]; idle?: boolean }) {
  return (
    <div className="card alist">
      <div className="cols-h"><span>Agent</span><span>Doing</span><span>Branch</span><span>Last hour</span><span>Spend</span><span>Seen</span></div>
      {rows.map((r) => <AgentRow key={r.paneId ?? r.session ?? r.name} r={r} spend={spend} idle={idle} />)}
    </div>
  );
}

export function WorkingSection({ working, idle, gone, hidden, hiddenDetail, onChanged }: {
  working: LanternRow[]; idle: LanternRow[]; gone: LanternRow[];
  hidden: { reports: number; routine: number } | null; hiddenDetail: string[]; onChanged: () => void;
}) {
  const [showIdle, setShowIdle] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const spend = [...working, ...idle].map((r) => r.facts?.cost ?? 0);
  const clear = (name: string) => { void api.agentForget(name).then(onChanged).catch(() => {}); };
  const hiddenWords = [
    hidden?.reports ? <span key="r"><b>{hidden.reports}</b> old report{hidden.reports === 1 ? "" : "s"}</span> : null,
    hidden?.routine ? <span key="c"><b>{hidden.routine}</b> routine check{hidden.routine === 1 ? "" : "s"}</span> : null,
    gone.length ? <span key="g"><b>{gone.length}</b> gone agent{gone.length === 1 ? "" : "s"}</span> : null,
  ].filter(Boolean) as ReactNode[];
  return (
    <div>
      <SectionHead title="Working" count={working.length} tone="ok" />
      <SubLine src="from hooks and tmux panes" icon="terminal-window" notify="quiet" />
      {working.length === 0
        ? <Empty icon="terminal-window" title="No agents yet">Start a Claude session in tmux, or let the coordinator start some.</Empty>
        : <Table rows={working} spend={spend} />}
      {idle.length > 0 && (
        <>
          <div className="gap10" />
          <div className="fold">
            <Ph name="circle-dashed" size={15} /><b>{idle.length} idle</b>
            {idle.slice(0, 4).map((r) => (
              <span key={r.paneId ?? r.name} className="agv-chip line"><span className="dot idle" />{r.name} {(r.saidAt ?? r.facts?.lastSeen) ? ageShort(Date.now() - (r.saidAt ?? r.facts!.lastSeen!)) : ""}</span>
            ))}
            {idle.length > 4 && <span>+{idle.length - 4}</span>}
            <span className="sp" />
            <button type="button" className="btn sm" aria-expanded={showIdle} onClick={() => setShowIdle((v) => !v)}>{showIdle ? "Hide" : "Show"}</button>
          </div>
          {showIdle && <><div className="gap10" /><Table rows={idle} spend={spend} idle /></>}
        </>
      )}
      {hiddenWords.length > 0 && (
        <>
          <div className="gap10" />
          <div className="fold">
            <Ph name="eye-slash" size={15} />
            <span>Hidden: {hiddenWords.map((w, i) => <span key={i}>{i > 0 ? ", " : ""}{w}</span>)}</span>
            <span className="sp" />
            <button type="button" className="btn sm" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Hide" : "Show"}</button>
          </div>
          {showHidden && (
            <div className="foldout">
              {hiddenDetail.map((l, i) => <div key={i}>{l}</div>)}
              {gone.map((r) => (
                <div key={r.paneId ?? r.name}>
                  <b style={{ color: "var(--text2)" }}>{r.name}</b>
                  <span>no pane here, quiet for hours</span>
                  {r.from === "said" && <button type="button" className="btn sm quiet" onClick={() => clear(r.name)} title="Take this name off the board">Clear</button>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── up next ──────────────────────────────────────────────────────────── */

/*
 * The approved design draws the queue and nothing to put on it by hand: the
 * coordinator fills it in. Putting a task on it is the `agentglass-agent task`
 * door and opening the schedule dialog is the `lantern.schedule` door, so
 * neither is drawn here.
 */
export function UpNext({ seat, schedules, onCancel, showEmpty }: {
  seat: SeatAnswer | null; schedules: AgentSchedule[]; onCancel: (id: string) => void; showEmpty: boolean;
}) {
  const tasks = (seat?.tasks ?? []).filter((t) => !t.doneAt);
  const started = tasks.filter((t) => t.takenAt).length;
  const shown = tasks.slice(0, 8);
  const later = schedules.filter((s) => !s.firedAt && !isDeadSchedule(s));
  const total = tasks.length + later.length;
  if (!showEmpty && total === 0) return null;
  return (
    <div>
      <SectionHead title="Up next" count={total} hint={total ? `${started} of ${total} started` : undefined} />
      <SubLine src="from the coordinator" icon="robot" notify="quiet" />
      {total === 0
        ? <Empty icon="list-checks" title="The queue is empty">The coordinator fills this in.</Empty>
        : (
          <>
            <div className="seg4" style={{ gridTemplateColumns: `repeat(${shown.length + later.length}, 1fr)` }}>
              {shown.map((t) => <i key={t.id} className={t.takenAt ? "p" : ""} />)}
              {later.map((s) => <i key={s.id} />)}
            </div>
            <div className="card">
              {shown.map((t) => (
                <div className="qr" key={t.id}>
                  <span className={`s${t.takenAt ? " p" : ""}`}><Ph name={t.takenAt ? "play" : "hourglass-medium"} size={18} /></span>
                  <div className="ti" title={t.proof ? `${t.title}. Done when ${t.proof}` : t.title}>{t.title}</div>
                  {t.takenAt
                    ? <span className="av" title={`${t.takenBy || "unnamed"}, ${fmtAgo(t.takenAt)} ago`}>{(t.takenBy || "?")[0]!.toUpperCase()}</span>
                    : <span className="av free" title="Nobody has it yet"><Ph name="arrow-right" size={12} /></span>}
                </div>
              ))}
              {later.map((s) => (
                <div className="qr" key={s.id}>
                  <span className="s"><Ph name="clock" size={18} /></span>
                  <div className="ti" title={s.prompt || s.name}>{s.name} <span className="mut" style={{ fontSize: 12 }}>{new Date(s.due).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
                  <button type="button" className="btn sm quiet" onClick={() => onCancel(s.id)} title="Cancel this scheduled start">Cancel</button>
                </div>
              ))}
            </div>
          </>
        )}
    </div>
  );
}

/* ── clean up ─────────────────────────────────────────────────────────── */

const GROUP_ICON: Record<CleanKind, PhName> = { "left-behind": "hard-drives", duplicates: "copy", idle: "clock", schedule: "calendar-x" };

function CleanGroupRow({ g, onChanged }: { g: CleanGroup; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async () => {
    setBusy(true); setErr("");
    try {
      if (g.kind === "schedule") {
        const r = await api.agentUnschedule(g.scheduleIds[0]!);
        if (!r.ok) setErr(r.error ?? "could not remove it");
      } else {
        /* One server at a time through the route that stops one: nothing here
           can stop a process the machine view would not. */
        let stopped = 0; let last = "";
        for (const pid of g.pids) {
          const r = await api.machineKill(pid).catch(() => ({ ok: false, error: "no answer" }));
          if (r.ok) stopped++; else last = r.error ?? "could not stop it";
        }
        if (stopped < g.pids.length) setErr(`stopped ${stopped} of ${g.pids.length}: ${last}`);
      }
    } catch { setErr("that did not go through"); }
    setBusy(false); onChanged();
  };
  const days = g.oldestDays;
  return (
    <div className="lo">
      <div className="t1">
        <div className="big">{g.count}</div>
        <div><div className="tt"><Ph name={GROUP_ICON[g.kind]} size={16} />{g.title}</div><div className="sub">{g.sub}</div></div>
        <button type="button" className={`btn sm${g.kind === "schedule" ? "" : " stop"}`} disabled={busy || (g.kind !== "schedule" && g.pids.length === 0)} onClick={() => void act()}>
          <Ph name={g.kind === "schedule" ? "trash" : "stop-circle"} size={14} />{busy ? "Working…" : g.button}
        </button>
      </div>
      <div className="t2">
        {g.chips.length > 0
          ? <div className="ports">{g.chips.map((c, i) => <span key={i} className="port" title={c.title}>{c.label}</span>)}{g.more > 0 && <span className="port more">+{g.more}</span>}</div>
          : <span />}
        {days !== null && (
          <div className="agebar" title={`oldest: ${days} days`}>
            <span style={{ color: "var(--warning)" }}>{days} d</span>
            <div className="meter"><i style={{ width: `${Math.min(100, Math.round((days / 60) * 100))}%`, background: "var(--warning)" }} /></div>
          </div>
        )}
      </div>
      {err && <div className="err-line" role="alert" style={{ paddingLeft: 58 }}>{err}</div>}
    </div>
  );
}

export function CleanUpSection({ clean, onChanged }: { clean: { groups: CleanGroup[]; total: number }; onChanged: () => void }) {
  return (
    <div>
      <SectionHead title="Clean up" count={clean.total} tone="warn" />
      <SubLine src="from a scan of running processes" icon="magnifying-glass" notify="quiet" />
      {clean.groups.length === 0
        ? <Empty icon="broom" title="Nothing left running">Forgotten servers and dead schedules appear here.</Empty>
        : <div className="card">{clean.groups.map((g) => <CleanGroupRow key={`${g.kind}-${g.scheduleIds[0] ?? ""}`} g={g} onChanged={onChanged} />)}</div>}
    </div>
  );
}
