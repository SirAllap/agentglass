import { useCallback, useEffect, useMemo, useState } from "react";
import "./flightPlanView.css";
import "./pilotView.css";
import { api } from "../../lib/api.ts";
import { openTicketOnBench } from "../../lib/lanternAsk.ts";
import { usd, type PlanDetail } from "../../lib/flightPlan.ts";
import { answerText, flightGroups, flightItems, needsYou, nextWaiting, stripCounts, stripFor, type FlightItem, type Handled, type Pilot, type PilotQuestion, type PilotSnapshot, type StripButtonId } from "../../lib/flightPilot.ts";
import { projectRoots } from "../../lib/flightProjects.ts";
import { onFlightPlanChanged, setWaiting } from "../../lib/flightPlanWaiting.ts";
import { subscribeFlightPlanIntent, takeFlightPlanIntent, type FlightPlanTab } from "../../lib/flightPlanNav.ts";
import { ICON } from "../../lib/iconSize.ts";
import { PILOT_KEYS, encode, noteFor } from "../../lib/pilotSettings.ts";
import { CardPopover } from "./CardPopover.tsx";
import { Composer, type Preset } from "./Composer.tsx";
import { GoCard, type CardAnswer } from "./GoPoll.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { FlightGroups } from "./FlightGroups.tsx";
import type { RowDo } from "./FlightList.tsx";
import { openLiveWindow } from "../../lib/liveWindow.ts";
import { latchGitModal } from "../../lib/gitModalIntent.ts";
import { PilotStrip } from "./PilotStrip.tsx";
import { PlansTab } from "./PlansTab.tsx";
import { SettingsTab } from "./SettingsTab.tsx";
import { PlaneIcon, PlusIcon } from "./fpIcons.tsx";
import { Trajectory } from "./Trajectory.tsx";
import { DEFAULT_CFG, useFlightPlan } from "./useFlightPlan.ts";
import { BLANK, usePilotRoster } from "./usePilotFeed.ts";
import { monthSpend, historyRows, goOutcome } from "../../lib/flightPlan.ts";

const FLOW = ["Request", "Flight plan", "Mockup", "Preflight", "Findings", "Go / No-go", "Launch"];
const NO_HANDLED: Handled = { fixed: 0, contested: 0, dismissed: 0 };

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [active, ms]);
  return now;
}

/**
 * THE FLIGHT PLAN. A request becomes a plan, a reader with no context reviews it,
 * the person (or, in Co-pilot and Autopilot, the coordinator) answers what it
 * finds, and Go launches the plan in a builder's own tab. The Flying tab is the
 * status strip and one row per flight; a row opens the plan, and the one card
 * that asks the person (a question or Go) opens over the list. The decisions are
 * in lib/flightPilot.ts and lib/flightPlan.ts. Findings are advisory: nothing
 * here lets one switch Go off.
 */
export function FlightPlanView({ active }: { active: boolean }) {
  const [tab, setTab] = useState<FlightPlanTab>("plans");
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [card, setCard] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<Preset | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [stripBusy, setStripBusy] = useState(false);
  const [stripErr, setStripErr] = useState("");
  const d = useFlightPlan(active, selected);
  const details: PlanDetail[] = useMemo(() => d.details ?? [], [d.details]);
  const off = d.enabled === false;
  const allItems = useMemo(() => flightItems(details), [details]);
  /* Every project the view speaks of: the one the person is in, the open ones, and any that only has plans. */
  const roots = useMemo(() => projectRoots([d.root], d.projects, allItems.map((it) => it.plan.root)), [d.root, d.projects, allItems]);
  const pf = usePilotRoster(active, roots, !off, d.budget);
  const onOf = (r: string): boolean => pf.feeds[r]?.on ?? true;
  /* A project the person left out has no plans waiting, no Go card and no strip: nothing below counts it. */
  const items = useMemo(() => allItems.filter((it) => pf.feeds[it.plan.root]?.on ?? true), [allItems, pf.feeds]);
  const inFlight = details.some((x) => x.run?.state === "running");
  const flyingAny = items.some((it) => it.plan.state === "launched" && it.landedAt == null);
  /* Only for the re-render it causes: the seconds of a Preflight reading, and the "4 min ago" of a builder's report. */
  useNow(active && (inFlight || flyingAny), inFlight ? 1000 : 30_000);
  const nowMs = Date.now();
  /* Each project's own mode, hold and seat, plus what its plans list adds: builders in the air (launched, not landed) and who held, when. */
  const snaps = useMemo(() => {
    const out: Record<string, PilotSnapshot> = {};
    for (const r of roots) {
      const mine = items.filter((it) => it.plan.root === r);
      const held = mine.find((it) => it.plan.heldAt != null || it.plan.heldBy != null)?.plan;
      out[r] = { ...(pf.feeds[r]?.snap ?? BLANK), flying: mine.filter((it) => it.plan.state === "launched" && it.landedAt == null).length, heldBy: held?.heldBy ?? null, heldAt: held?.heldAt ?? null };
    }
    return out;
  }, [roots, items, pf.feeds]);
  const snapOf = (r: string): PilotSnapshot => snaps[r] ?? BLANK;
  const engineOf = (r: string): boolean => pf.feeds[r]?.engine ?? false;
  const itemsOf = (r: string): FlightItem[] => items.filter((it) => it.plan.root === r);
  const takenOf = (id: string) => taken.has(id);
  /* The "Now" line of each mode card in Settings: what would wait on the person if the project flew in it, from today's plans. */
  const waitingByMode = (r: string): Record<Pilot, number> => {
    const as = (pilot: Pilot) => ({ pilot, seat: snapOf(r).seat, held: false, budgetReached: null });
    return { manual: flightGroups(itemsOf(r), nowMs, as("manual")).waiting.length, copilot: needsYou(itemsOf(r), as("copilot")).go, autopilot: needsYou(itemsOf(r), as("autopilot")).questions };
  };
  const pilotFor = (id: string): Pilot => (takenOf(id) ? "manual" : snapOf(items.find((it) => it.plan.id === id)?.plan.root ?? "").pilot);
  /* Plans of more than one project are in the air: one block per project. One project (or none) keeps the single strip. */
  const planRoots = useMemo(() => projectRoots(items.map((it) => it.plan.root)), [items]);
  const grouped = planRoots.length > 1;
  const focus = planRoots[0] ?? d.root;
  const groups = useMemo(() => {
    const out = { waiting: [] as FlightItem[], flying: [] as FlightItem[], ground: [] as FlightItem[], landed: [] as FlightItem[] };
    for (const r of roots) { const g = flightGroups(items.filter((it) => it.plan.root === r), nowMs, snaps[r] ?? BLANK); out.waiting.push(...g.waiting); out.flying.push(...g.flying); out.ground.push(...g.ground); out.landed.push(...g.landed); }
    return out;
  }, [roots, items, nowMs, snaps]);

  /* A request from elsewhere (the chip, the popover, a card, the palette): drained on mount and whenever one arrives. */
  useEffect(() => {
    const take = () => {
      const i = takeFlightPlanIntent();
      if (!i) return;
      if (i.tab) setTab(i.tab);
      if (i.plan) { setSelected(i.plan); setOpened(true); setTab("plans"); }
      if (i.card) { setCard(i.card); setTab("plans"); }
      if (i.compose) setCompose(i.compose);
    };
    take();
    return subscribeFlightPlanIntent(take);
  }, []);

  /* The chip and the popover in the top bar read what waits on the person from here, so they never lag the view. */
  useEffect(() => {
    if (d.details === null || d.enabled === null) return;
    const n = roots.reduce((t, r) => { const x = needsYou(items.filter((it) => it.plan.root === r), snaps[r] ?? BLANK); return { go: t.go + x.go, questions: t.questions + x.questions }; }, { go: 0, questions: 0 });
    const asks = groups.waiting.flatMap((it) => (it.questions ?? []).filter((q) => q.answer === null).slice(0, 1).map((q) => ({ id: q.id, planId: it.plan.id, title: it.plan.title, text: q.text })));
    const plans = groups.waiting.filter((it) => !(it.questions ?? []).some((q) => q.answer === null)).map((it) => ({ id: it.plan.id, title: it.plan.title }));
    setWaiting(d.enabled ? { on: true, plans, go: n.go, questions: n.questions, asks } : { on: false, plans: [], go: 0, questions: 0, asks: [] });
  }, [d.details, d.enabled, items, groups, roots, snaps]);

  const cfgOf = (root: string) => d.cfg[root] ?? DEFAULT_CFG;
  const reloadAll = () => { d.reload(); pf.read(); };
  /* The server says a plan, hold or question changed: read again once the burst is over, with no clock. */
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onFlightPlanChanged(() => { clearTimeout(t); t = setTimeout(() => { d.reload(); pf.read(); }, 300); });
    return () => { off(); clearTimeout(t); };
  }, [active, d.reload, pf.read]);
  const open = (r: { id: string; root: string; ticket?: string }) => {
    reloadAll(); setSelected(r.id); setOpened(true); setTab("plans");
    if (r.ticket) void openTicketOnBench(r.root, r.ticket, "flight plan");
  };

  const go = useCallback(async (id: string) => {
    const cur = details.find((x) => x.plan.id === id)?.plan;
    setBusy(true); setErr("");
    try {
      /* Go launches by itself; a launch that could not start leaves the plan at Go with the reason, and the card's Launch button is the retry. */
      if (cur?.state === "go") { const l = await api.flightPlanLaunch(id); if (!l.ok) setErr(l.error ?? "the launch did not start"); return; }
      const o = goOutcome(await api.flightPlanGo(id));
      if (o.kind === "refused" || o.kind === "retry") setErr(o.error);
    } catch { setErr("could not reach the server"); } finally { setBusy(false); reloadAll(); }
  }, [details, d, pf]); // eslint-disable-line react-hooks/exhaustive-deps
  const nogo = useCallback(async (id: string, reason: string) => {
    setBusy(true); setErr("");
    const r = await api.flightPlanNoGo(id, reason).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; error?: string }));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "No-go was refused");
    reloadAll();
  }, [d, pf]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (planId: string, q: PilotQuestion, a: CardAnswer) => {
    const text = answerText(q, a);
    if (!text) return;
    setBusy(true); setErr("");
    const r = await api.flightAnswer(planId, text).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; error?: string }));
    setBusy(false);
    if (!r.ok) { setErr(noteFor(r)?.text ?? r.error ?? "the answer was not sent"); return; }
    setAnswered((m) => ({ ...m, [planId]: q.id }));
    reloadAll();
  };
  /* The engine has no per-plan take-over: this window answers that plan's findings as Manual until it is closed. */
  const takeOver = (id: string) => setTaken((s) => new Set(s).add(id));

  const [stripRoot, setStripRoot] = useState("");
  const stripAct = async (root: string, fn: () => Promise<{ ok: boolean; applied?: boolean; error?: string }>) => {
    setStripRoot(root); setStripBusy(true); setStripErr("");
    const r = await fn().catch(() => ({ ok: false, error: "could not reach the server" }));
    setStripBusy(false);
    if (!r.ok) setStripErr(noteFor(r)?.text ?? r.error ?? "not done");
    pf.read();
  };
  useEffect(() => {
    if (!stripErr) return;
    const t = setTimeout(() => setStripErr(""), 6000);
    return () => clearTimeout(t);
  }, [stripErr]);
  const next = (root: string) => {
    const it = nextWaiting(itemsOf(root), nowMs, snapOf(root));
    if (it) setCard(it.plan.id);
  };
  const onStrip = (id: StripButtonId, root: string) => {
    if (id === "hold") void stripAct(root, () => api.flightHold(root));
    else if (id === "resume") void stripAct(root, () => api.flightResume(root));
    else if (id === "review-go" || id === "open-next") next(root);
    else setTab("settings");
  };
  const toCopilot = (root: string) => void stripAct(root, async () => {
    const k = PILOT_KEYS.pilot;
    const w = await api.settingAtSet(k.id, encode("pilot", "copilot"), k.scope === "project" ? root : "").catch(() => ({ ok: false, error: "could not reach the server" }));
    return w.ok ? api.flightResume(root) : w;
  });

  const turnOn = async () => {
    const r = await api.settingsDoorSet("flightPlan.enabled", true).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; applied?: boolean; error?: string }));
    if (!r.ok) { setErr(r.error ?? "not turned on"); return; }
    d.setEnabled(true); d.refreshCfg(); reloadAll();
  };

  /* The tab counts builders with an open tab only: a plan on the ground, or still in Preflight, is not a builder in the air. */
  const live = groups.flying.filter((it) => it.plan.builder === "live").length + groups.waiting.filter((it) => it.plan.builder === "live").length;
  const sel = details.find((x) => x.plan.id === selected);
  const selRoot = sel?.plan.root ?? focus;
  const selCfg = cfgOf(selRoot);
  const rows = useMemo(() => historyRows(details, d.runs), [details, d.runs]);
  const stripOf = (r: string) => {
    const sn = snapOf(r);
    const s = stripFor(sn, stripCounts(itemsOf(r), nowMs, sn));
    /* Counts of plans nobody read are not zero: say what is true rather than "0 waiting on you". */
    if (d.details !== null || s.mode === "held") return s;
    const lead = d.error ? "Plans not read." : "Reading the plans.";
    return { ...s, lead, sentence: d.error ? `${lead} Nothing below is current.` : lead };
  };

  /* Row buttons: the builder's tab comes to the front, the branch opens in the Git view's compare, a hold is lifted. */
  const rowDo: RowDo = (kind, it) => {
    const l = it.plan.launched;
    if (kind === "open-tab" && l?.session && l.window) void openLiveWindow({ session: l.session, windowId: l.window, paneId: "", name: l.branch ?? "", path: l.worktree ?? "" });
    else if (kind === "open-branch" && l?.branch) latchGitModal({ which: "compare", base: l.base ?? l.from ?? "main", root: l.worktree ?? it.plan.root });
    else if (kind === "lift-hold") void api.flightResume(it.plan.root).then(() => reloadAll()).catch(() => setErr("could not reach the server"));
  };

  const show = (t: FlightPlanTab) => { setTab(t); setOpened(false); reloadAll(); };

  /* One card, two homes: the popover over the list, and the column beside an open plan. */
  const renderCard = (id: string, popover: boolean) => {
    const it = items.find((x) => x.plan.id === id);
    if (!it) return null;
    const q = (it.questions ?? []).find((x) => x.answer === null) ?? (it.questions ?? []).find((x) => x.id === answered[id]) ?? null;
    return (
      <GoCard
        plan={it.plan} run={it.run} pilot={pilotFor(id)} handled={it.facts?.handled ?? NO_HANDLED} question={q}
        busy={busy} error={err} popover={popover}
        onGo={() => void go(id)} onNoGo={(r) => void nogo(id, r)} onAnswer={(a) => q && void answer(id, q, a)}
        onTakeOver={() => { takeOver(id); setCard(null); setSelected(id); setOpened(true); }}
        onStop={() => { void nogo(id, "Stopped by you from the orchestrator's question."); setCard(null); }}
        onSee={() => { setCard(null); setSelected(id); setOpened(true); }}
        onClose={() => setCard(null)}
      />
    );
  };

  const header = (
    <div className="vh">
      <div className="vt"><span className="ic"><PlaneIcon size={ICON.lg} /></span><h3>Flight plan</h3></div>
      {off ? <span className="chip off"><i />Off</span>
        : tab === "history" ? <span className="chip off"><i />{rows.length} {rows.length === 1 ? "plan" : "plans"} · {usd(monthSpend(rows, nowMs))} this month</span>
        : tab === "settings" ? <span className="chip ok"><i />On</span>
        : null}
      <div className="r">
        <div className="seg" role="group" aria-label="Flight plan sections">
          <button type="button" aria-pressed={tab === "plans"} onClick={() => show("plans")}>Flying{!off && live > 0 && <span className="c" title={`${live} ${live === 1 ? "builder" : "builders"} live`}>{live}</span>}</button>
          <button type="button" aria-pressed={tab === "history"} onClick={() => show("history")}>History</button>
          <button type="button" aria-pressed={tab === "settings"} onClick={() => show("settings")}>Settings</button>
        </div>
        {!off && <button type="button" className="btn sm primary" onClick={() => setCompose({})}><PlusIcon size={ICON.sm} />New flight plan</button>}
      </div>
    </div>
  );

  let body;
  if (tab === "settings") {
    const scope = {
      rows: roots.map((r) => ({ root: r, on: onOf(r), strip: stripOf(r), seat: snapOf(r).seat, waiting: flightGroups(itemsOf(r), nowMs, snapOf(r)).waiting.length })),
      waitingFor: (r: string) => (d.details === null ? undefined : waitingByMode(r)),
      snapshotFor: (r: string) => (engineOf(r) ? snapOf(r) : null),
    };
    body = <SettingsTab enabled={!off} root={d.root} onEnabled={d.setEnabled} onChanged={() => { d.refreshCfg(); reloadAll(); }} scope={scope} />;
  } else if (off && d.details !== null) {
    body = (
      <div className="empty">
        <div>
          <div className="arc"><Trajectory states={["todo", "todo", "todo", "todo", "todo", "todo", "todo"]} bare /></div>
          <h4>Have a fresh pair of eyes read every plan before Launch</h4>
          <p>A reviewer that never saw the conversation reads the plan and its mockup, lists what is unclear or wrong, and nothing is built until you, or the orchestrator, say Go.</p>
          <div className="flow">{FLOW.map((s, i) => <span key={s} style={{ display: "contents" }}>{i > 0 && <em>→</em>}<span>{s}</span></span>)}</div>
          <button type="button" className="btn primary" style={{ height: 34, padding: "0 18px" }} onClick={() => void turnOn()}>Turn on Flight plan</button>
          <p style={{ margin: "12px auto 0", fontSize: 10.9 }}>Starts on the safe setting: Ask me before Launch, Sonnet 5.5, $0.50 cap. Change it in <button type="button" className="textlink" onClick={() => show("settings")}>Settings</button>, here.</p>
          {err && <p role="alert" style={{ color: "var(--error)" }}>{err}</p>}
        </div>
      </div>
    );
  } else if (tab === "history") {
    body = <HistoryTab details={details} runs={d.runs} now={nowMs} onOpen={(id) => { setSelected(id); setOpened(true); setTab("plans"); }} />;
  } else {
    const listed = !(opened && sel);
    const plansErr = d.details === null && d.error;
    body = (
      <div className="pv ps pv-body" data-grouped={grouped && listed && !plansErr ? "" : undefined}>
        {!(grouped && listed && !plansErr) && <PilotStrip strip={stripOf(selRoot)} engine={engineOf(selRoot)} busy={stripBusy} error={stripErr} onButton={(id) => onStrip(id, selRoot)} onSecondary={() => toCopilot(selRoot)} />}
        {plansErr
          ? <div className="pv-flights"><div className="err-note" role="alert"><span className="sev b" aria-hidden="true">!</span><div><b>{d.error}.</b> The plans could not be read; it tries again when you press a tab.</div></div></div>
          : grouped && listed
          ? <FlightGroups
              groups={planRoots.map((r) => ({ root: r, items: itemsOf(r), snap: snapOf(r), strip: stripOf(r), engine: engineOf(r) }))}
              loading={d.details === null} now={nowMs} busy={stripBusy} error={stripErr} actRoot={stripRoot}
              onButton={onStrip} onSecondary={toCopilot} onOpen={(id) => { setSelected(id); setOpened(true); }} onCard={setCard} onDo={rowDo} onHistory={() => setTab("history")} onCompose={() => setCompose({})} />
          : <PlansTab
              items={grouped ? itemsOf(selRoot) : items} details={details} loading={d.details === null} snap={snapOf(selRoot)} selected={selected} open={opened} now={nowMs} preflightOn={selCfg.before !== "off"} cap={selCfg.cap}
              pilotFor={pilotFor} renderCard={(id) => renderCard(id, false)}
              onOpen={(id) => { setSelected(id); setOpened(true); }} onBack={() => setOpened(false)} onCard={setCard} onDo={rowDo} onChanged={reloadAll} onTakeOver={takeOver}
              onSettings={() => setTab("settings")} onHistory={() => setTab("history")} onCompose={() => setCompose({})} />}
      </div>
    );
  }

  /* A card for a plan that is gone (deleted, or in another project's list) is not drawn. */
  const cardOk = card !== null && items.some((x) => x.plan.id === card);

  return (
    <div className="fpv">
      <div>
      {header}
      {d.error && d.details !== null && <div className="vbanner"><div className="err-note" role="alert"><span className="sev b" aria-hidden="true">!</span><div><b>{d.error}.</b> What is shown may be out of date; it reads again when you come back to the window or press a tab.</div></div></div>}
      </div>
      {body}
      {cardOk && tab === "plans" && (
        <CardPopover label={`Flight plan: ${items.find((x) => x.plan.id === card)?.plan.title ?? ""}`} onClose={() => setCard(null)}>{renderCard(card!, true)}</CardPopover>
      )}
      {compose && <Composer projects={d.projects} root={d.root} preset={compose} cfg={d.cfg} onClose={() => setCompose(null)} onCreated={(r) => { setCompose(null); open(r); }} />}
    </div>
  );
}
