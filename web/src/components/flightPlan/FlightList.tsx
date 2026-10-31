import { useEffect, useRef, useState } from "react";
import { lastWasKey } from "./inputMode.ts";
import { flightGroups, flightNow, handledChip, plural, rowAction, rowMeta, stationsOf, stripCounts, type FlightItem, type PilotSnapshot, type RowAction } from "../../lib/flightPilot.ts";
import { BranchIcon, DoneIcon, HandIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PauseIcon, PlaneIcon, PlusIcon } from "./fpIcons.tsx";
import { StateTile } from "./StateBadge.tsx";
import { Track } from "./Trajectory.tsx";

const FADE_MS = 180;

/*
 * Rows that arrive or leave fade (opacity only, no height), once the list has
 * been drawn: the first draw, a tab change and anything done from the keyboard
 * do not animate. A row that left stays in the list, faded and inert, for the
 * length of the fade, so it does not vanish mid-sentence; then the rest close up.
 */
type Entry = { it: FlightItem; state: "in" | "enter" | "out" };
/* Worked out while rendering, so a row is in the DOM at opacity 0 on its first paint and the transition has something to run from. */
function usePresence(items: FlightItem[], enabled: boolean): Entry[] {
  const [, tick] = useState(0);
  const prev = useRef<Map<string, FlightItem> | null>(null);
  const gone = useRef(new Map<string, FlightItem>());
  const cur = new Map(items.map((i) => [i.plan.id, i]));
  const animate = enabled && prev.current !== null && !lastWasKey();
  const fresh = animate ? [...cur.keys()].filter((id) => !prev.current!.has(id)) : [];
  if (animate) for (const [id, it] of prev.current!) if (!cur.has(id)) gone.current.set(id, it);
  for (const id of cur.keys()) gone.current.delete(id);
  useEffect(() => {
    if (enabled) prev.current = cur;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (fresh.length) timers.push(setTimeout(() => tick((n) => n + 1), 20));
    if (gone.current.size) timers.push(setTimeout(() => { gone.current.clear(); tick((n) => n + 1); }, FADE_MS));
    return () => timers.forEach(clearTimeout);
  });
  return [...items.map((it): Entry => ({ it, state: fresh.includes(it.plan.id) ? "enter" : "in" })), ...[...gone.current.values()].map((it): Entry => ({ it, state: "out" }))];
}

/** The buttons a row can carry beyond Answer and Review Go (they open the card): what each does is decided by the view. */
export type RowDo = (kind: Extract<RowAction["kind"], "open-tab" | "open-branch" | "lift-hold">, it: FlightItem) => void;
const SLOT_NAMES = 2;

function Row({ it, snap, now, state, onOpen, onCard, onDo }: { it: FlightItem; snap: PilotSnapshot; now: number; state: Entry["state"]; onOpen: (id?: string) => void; onCard: () => void; onDo: RowDo }) {
  const meta = rowMeta(it);
  const n = flightNow(it, snap, now);
  const a = rowAction(it, snap, now);
  const asks = a.kind === "answer";
  const [lead, tail] = a.kind === "handled" ? handledChip(it.facts?.handled ?? { fixed: 0, contested: 0, dismissed: 0 }).split(" · ") : [];
  const holders = n.state.id === "queued" ? it.plan.slotHolders ?? [] : [];
  return (
    <li className="pv-row" data-state={state === "in" ? undefined : state} data-wait={a.kind !== "handled" && n.state.group === "waiting" ? "" : undefined} data-ask={asks ? "" : undefined} data-sid={n.state.id}>
      <StateTile state={n.state} />
      <div>
        <button type="button" className="pv-open" onClick={() => onOpen()} aria-label={`Open ${it.plan.title}`}><div className="t" title={it.plan.title}>{it.plan.title}</div></button>
        <div className="m">
          {meta.size && <span className="size">{meta.size}</span>}
          {holders.length > 0
            ? <span className="slots">slots held by{holders.slice(0, SLOT_NAMES).map((h) => <button key={h.id} type="button" className="slot" title={h.title} onClick={() => onOpen(h.id)}>{h.title}</button>)}{holders.length > SLOT_NAMES && <b>+{holders.length - SLOT_NAMES}</b>}</span>
            : meta.builder
            ? <span title={meta.builder.branch}>builder <b>{meta.builder.branch}</b>{meta.builder.tab ? ` · tab ${meta.builder.tab}` : ""}</span>
            : <span>{meta.project} · {meta.who}</span>}
        </div>
      </div>
      <Track stations={stationsOf(it, snap, now)} />
      <div className="pv-now">
        <b aria-live="polite" title={n.bold}>{n.bold}</b>
        <span className="nx" title={`Next: ${n.next}`}><em>Next</em><i data-tone={n.state.tone} />{n.next}</span>
        {n.report ? <span className="rp" title={`Last report ${n.report}`}><em>Report</em>{n.report}</span> : <span className="rp gap"><em>Report</em>none yet</span>}
      </div>
      {a.kind === "answer" && <button type="button" className="btn answer" onClick={onCard}>{a.label}</button>}
      {a.kind === "go" && <button type="button" className="btn go" onClick={onCard}>{a.label}</button>}
      {a.kind === "decide" && <button type="button" className="btn answer" onClick={() => onOpen()}>{a.label}</button>}
      {a.kind === "open-tab" && <button type="button" className="btn" onClick={() => onDo("open-tab", it)}>{a.label}</button>}
      {a.kind === "open-branch" && <button type="button" className="btn" onClick={() => onDo("open-branch", it)}><BranchIcon size={ICON.xs} />{a.label}</button>}
      {a.kind === "lift-hold" && <button type="button" className="btn" onClick={() => onDo("lift-hold", it)}><PauseIcon size={ICON.xs} />{a.label}</button>}
      {a.kind === "handled" && <span className="pv-handled" title={tail ? `${lead} · ${tail}` : lead}>{tail ? <><b>{lead}</b> · {tail}</> : lead}</span>}
    </li>
  );
}

function Skeleton() {
  return (
    <div className="pv-flights" aria-busy="true" aria-label="Reading the flights">
      {[0, 1].map((i) => (
        <div key={i} className="pv-skel">
          <div><div className="skel" style={{ width: "70%" }} /><div className="skel" style={{ width: "45%" }} /></div>
          <div className="skel" style={{ height: 6 }} />
          <div><div className="skel" style={{ width: "55%" }} /><div className="skel" style={{ width: "80%" }} /></div>
        </div>
      ))}
    </div>
  );
}

/** One row per flight, grouped by who is wanted: you, then the ones flying; what landed today is a count that leads to History. */
export function FlightList({ items, loading, snap, now, scope = "", onOpen, onCard, onDo, onHistory, onCompose }: {
  items: FlightItem[]; loading: boolean; snap: PilotSnapshot; now: number;
  /** Tells this list's headings from another list's on the same page. */
  scope?: string;
  onOpen: (id: string) => void; onCard: (id: string) => void; onDo: RowDo; onHistory: () => void; onCompose: () => void;
}) {
  const g = flightGroups(items, now, snap);
  const waiting = usePresence(g.waiting, !loading), flying = usePresence(g.flying, !loading), ground = usePresence(g.ground, !loading);
  if (loading) return <Skeleton />;
  if (!g.waiting.length && !g.flying.length && !g.ground.length && !g.landed.length) {
    return (
      <div className="pv-flights">
        <div className="pv-empty">
          <span className="arc"><PlaneIcon size={ICON.xl} /></span>
          <h4>No flights</h4>
          <p>Write what should be built in your own words and an author with context turns it into a plan. Nothing is built until Go.</p>
          <button type="button" className="btn primary" onClick={onCompose}><PlusIcon size={ICON.sm} />New flight plan</button>
        </div>
      </div>
    );
  }
  /* The strip's own count, so the heading and the strip never disagree about how many builders are live. */
  const live = stripCounts(items, now, snap).live;
  const more = g.flying.filter((it) => it.plan.builder !== "live").length;
  const section = (id: string, icon: React.ReactNode, label: React.ReactNode, rows: Entry[], actor?: string) => rows.length > 0 && (
    <section aria-labelledby={`pv-g-${scope}${id}`} style={{ display: "contents" }}>
      <h3 className="pv-gh" id={`pv-g-${scope}${id}`} data-actor={actor}>{icon}{label} <span className="n">{id === "fly" ? live : rows.filter((r) => r.state !== "out").length}</span>{id === "fly" && <span className="tail">{plural(live, "builder")} live{more ? ` · ${more} more in Preflight and checking` : ""}</span>}{id === "ground" && <span className="tail">costs nothing</span>}</h3>
      <ul className="pv-list">{rows.map((r) => <Row key={r.it.plan.id} it={r.it} snap={snap} now={now} state={r.state} onOpen={(id) => onOpen(id ?? r.it.plan.id)} onCard={() => onCard(r.it.plan.id)} onDo={onDo} />)}</ul>
    </section>
  );
  return (
    <div className="pv-flights" data-still={lastWasKey() ? "" : undefined}>
      {section("wait", <HandIcon size={ICON.sm} />, "Waiting on you", waiting, "person")}
      {section("fly", <PlaneIcon size={ICON.sm} />, "Flying", flying)}
      {section("ground", <PauseIcon size={ICON.sm} />, "On the ground", ground)}
      {g.landed.length > 0 && (
        <h3 className="pv-gh"><button type="button" onClick={onHistory}><DoneIcon size={ICON.sm} />Landed today <span className="n">· {g.landed.length}</span> <span className="tail">— in History</span></button></h3>
      )}
    </div>
  );
}
