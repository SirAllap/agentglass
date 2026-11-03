/*
 * The Flow canvas: the orchestrator, one block per step of the path, the arrows
 * between them and the pan, zoom and minimap that go with a drawing bigger than
 * its window. It paints what `flowView.ts` computes and reports what a person
 * did; the Flow value itself is edited by the caller, so the canvas keeps no
 * list of its own.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { roleById, type Flow, type FlowRole } from "../../../../../shared/flow.ts";
import type { RoleId } from "../../../../../shared/workerRoles.ts";
import {
  BLOCK_H, BLOCK_W, FIT_FLOOR, ORCH_H, ORCH_W, ZOOM_MAX, ZOOM_MIN, dropIndex, drawingBounds, fitView, layoutBlocks, miniMap, orchX, routeWires, toWorld, zoomAbout,
  type Pt, type View,
} from "../../../lib/flowView.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import type { Marks } from "./canvasRules.ts";
import { WorkerCard } from "./WorkerCard.tsx";
import { OrchestratorCard } from "./OrchestratorCard.tsx";
import type { LiveCounts } from "../../../lib/workerCardView.ts";
import type { OrchestratorCardData } from "../../../lib/orchestratorCardView.ts";

export interface CanvasProps {
  flow: Flow;
  selected: string | null;
  /** Say which block is open. */
  onSelect: (id: string | null) => void;
  /** A "+" in a gap was pressed: where on the path the new block would go. */
  onAddAt: (index: number) => void;
  /** A block was dropped on another place in the order. */
  onReorder: (id: string, index: number) => void;
  /** A block was dropped where it already was in the order, at a place of the person's choosing. */
  onMove: (id: string, x: number, y: number) => void;
  /** Drops every hand-placed position: the blocks go back to a tidy grid in path order, each after the one it follows. */
  onTidy?: () => void;
  /** The natural arrangement: the path as one flowing river instead of rows. */
  onFlowLayout?: () => void;
  /** A role of the team was dropped on the canvas. */
  onPlace: (roleId: string, index: number) => void;
  onUseTemplate: () => void;
  onAddFirst: () => void;
  /** What the empty state offers: the roles the shipped flow would put on the path. */
  templateNames: { id: string; name: string; hue: string }[];
  /** What rules say about each block (a policy field), drawn on the block itself: the box never changes size. */
  marks?: Marks;
  /** What the board says each role is doing now; absent until D4 answers, and the card says so. */
  counts?: LiveCounts | null;
  /** Whether the policy stops each role before it runs, by role id. */
  ask?: Partial<Record<RoleId, { ask: boolean }>> | null;
  /** A card's Configure, Enter or double-click: the one worker editor opens on it. */
  onConfigure: (id: string) => void;
  /** "Add a step after" from a card's menu: a new worker at that place on the path. */
  onAddAfter: (index: number) => void;
  /** "Remove step" from a card's menu. */
  onRemove: (id: string) => void;
  /** The orchestrator node was pressed while a rule is edited: the main agent joins the rule. */
  onOrchestrator?: () => void;
  /** What the orchestrator's card says: the chair, the seat, the plan and the board's line. Absent: the card draws what the flow alone holds. */
  orchestrator?: OrchestratorCardData | null;
  /** The card's Configure: the orchestrator's sheet opens. */
  onConfigureOrchestrator?: () => void;
  /** The card's "Open its tab": the session in the chair comes forward. */
  onOpenOrchestratorTab?: () => void;
  /** A block id (or `orchestrator`) whose settings the pointer is over: the view glides to it at the closest zoom, and back when the pointer leaves. */
  zoomToId?: string | null;
  /** The project the chair is seated in, as the orchestrator's strip names it. */
  project?: string;
  children?: never;
}

const hueVar = (r: FlowRole) => `var(--${r.hue})`;

/** Reference size the unplaced blocks are laid out for: wide enough for a row of seven. */
const WORLD_W = 2000, WORLD_H = 900;

export function FlowCanvas(p: CanvasProps) {
  const { flow } = p;
  const stageRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState({ w: 1100, h: 700 });
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [panning, setPanning] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The world is laid out for one fixed width and height, never the panel's or
  // the window's: opening the side panel or zooming the app shrinks the stage,
  // and a layout that followed it re-wrapped the blocks under the person's hands.
  const lay = useMemo(() => layoutBlocks(flow, WORLD_W, WORLD_H), [flow]);
  const wires = useMemo(() => routeWires(flow, lay), [flow, lay]);
  const bounds = useMemo(() => drawingBounds(flow, lay), [flow, lay]);

  // Fit when the drawing's own shape changes (a block added or removed), and for the first two sizes the
  // stage reports (the placeholder, then the measured one). After that a resize never refits: opening the
  // side panel shrinks the stage by a few hundred pixels, and a refit rescaled and moved every block under
  // the person's hands (measured: the same flow drew at a new zoom with the panel open).
  const touched = useRef(false);
  const flowShape = `${flow.path.join(",")}|${flow.edges.length}`;
  const sizeShape = `${Math.round(stage.w / 40)}|${Math.round(stage.h / 40)}`;
  useLayoutEffect(() => { touched.current = false; setView(fitView(bounds, stage, FIT_FLOOR)); }, [flowShape]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizeFits = useRef(0);
  useLayoutEffect(() => { if (++sizeFits.current <= 2 && !touched.current) setView(fitView(bounds, stage, FIT_FLOOR)); }, [sizeShape]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomTo = useCallback((factor: number, at?: Pt) => {
    touched.current = true;
    setGlide(false);
    setView((v) => zoomAbout(v, at ?? { x: stage.w / 2, y: stage.h / 2 }, factor));
  }, [stage.w, stage.h]);

  // A plain wheel zooms about the pointer, as it does in a design tool; shift (or a sideways swipe) pans. A pinch arrives as ctrl+wheel and is finer. A passive listener cannot stop the page scrolling, so this one is not.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setGlide(false);
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || e.metaKey) zoomTo(Math.exp(-e.deltaY * 0.01), at);
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { touched.current = true; setView((v) => ({ zoom: v.zoom, pan: { x: v.pan.x - (e.deltaX || e.deltaY), y: v.pan.y } })); }
      else zoomTo(Math.exp(-e.deltaY * 0.0015), at);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomTo]);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-fe-hit]")) return;
    const sx = e.clientX, sy = e.clientY, base = viewRef.current.pan;
    let moved = false;
    setGlide(false);
    setPanning(true);
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) { moved = true; touched.current = true; }
      setView((v) => ({ zoom: v.zoom, pan: { x: base.x + ev.clientX - sx, y: base.y + ev.clientY - sy } }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanning(false);
      if (!moved) p.onSelect(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    setGlide(false);
    const start = lay.places.get(id)!;
    const sx = e.clientX, sy = e.clientY;
    let moved = false, at = { x: start.x, y: start.y };
    const move = (ev: PointerEvent) => {
      const z = viewRef.current.zoom;
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      at = { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
      if (moved) setDrag({ id, ...at });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!moved) { p.onSelect(id); return; }
      const index = dropIndex(flow, lay, id, { x: at.x + BLOCK_W / 2, y: at.y + BLOCK_H / 2 });
      if (index !== flow.path.indexOf(id)) p.onReorder(id, index);
      else p.onMove(id, at.x, at.y);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDrop = (e: React.DragEvent) => {
    const data = e.dataTransfer.getData("text/plain");
    if (!data.startsWith("role:")) return;
    e.preventDefault();
    const r = stageRef.current!.getBoundingClientRect();
    const w = toWorld(view, { x: e.clientX - r.left, y: e.clientY - r.top });
    p.onPlace(data.slice(5), dropIndex(flow, lay, "", w));
  };

  // While a block is dragged the arrows follow it: the layout the wires are routed from has the block where the pointer is.
  const live = useMemo(() => {
    if (!drag) return { lay, wires };
    const places = new Map(lay.places);
    places.set(drag.id, { x: drag.x, y: drag.y });
    const l = { ...lay, places };
    return { lay: l, wires: routeWires(flow, l) };
  }, [drag, lay, wires, flow]);

  // Glide to the block whose settings are under the pointer. The view it left is kept and put back,
  // so a pass over the panel never costs the person their place. The centre is the stage's own, which
  // moves when the side panel is dragged wider or the window changes size.
  const [glide, setGlide] = useState(false);
  const before = useRef<View | null>(null);
  useEffect(() => {
    const id = p.zoomToId;
    if (!id) {
      // The panel reports a null field only when the pointer or focus leaves it, so this cannot step back to the old view between two sections.
      if (before.current) { setGlide(true); setView(before.current); before.current = null; }
      return;
    }
    const at = id === "orchestrator" ? { x: orchX(live.lay), y: 0, w: ORCH_W, h: ORCH_H } : (() => { const o = live.lay.places.get(id); return o ? { x: o.x, y: o.y, w: BLOCK_W, h: BLOCK_H } : null; })();
    if (!at || stage.w < 100) return;
    if (!before.current) before.current = viewRef.current;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (stage.w - 60) / at.w, (stage.h - 60) / at.h));
    setGlide(true);
    setView({ zoom: z, pan: { x: stage.w / 2 - (at.x + at.w / 2) * z, y: stage.h / 2 - (at.y + at.h / 2) * z } });
  }, [p.zoomToId, stage.w, stage.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const empty = flow.path.length === 0;
  const orchLeft = empty ? Math.max(40, (stage.w - ORCH_W) / 2) : orchX(live.lay);
  const worldW = empty ? stage.w : live.wires.width;
  const worldH = empty ? stage.h : live.wires.height;
  const mini = miniMap(flow, live.lay, view, stage, { w: 190, h: 118 });
  const pct = Math.round(view.zoom * 100);

  return (
    <section ref={stageRef} className="fe-stage" aria-label="Flow canvas" data-panning={panning ? "" : undefined}
      onPointerDown={startPan} onDragOver={(e) => { if (e.dataTransfer.types.includes("text/plain")) e.preventDefault(); }} onDrop={onDrop}>
      <div className="fe-world" data-glide={glide ? "" : undefined} style={{ width: worldW, height: worldH, transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}>
        {!empty && (
          <svg className="fe-wire" width={worldW} height={worldH} aria-hidden="true">
            <defs>
              <marker id="fe-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1l8 4-8 4z" fill="var(--text3)" />
              </marker>
              <marker id="fe-arrow-fail" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1l8 4-8 4z" fill="var(--error)" />
              </marker>
            </defs>
            {live.wires.trunk.spine.length > 0 && (
              <g>
                <polyline points={pts(live.wires.trunk.spine)} fill="none" stroke="var(--error)" strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" opacity={0.7} />
                {live.wires.trunk.drops.map((d) => (
                  <g key={`t-${d.x}`}>
                    <line x1={d.x} y1={d.from} x2={d.x} y2={d.to} stroke="var(--error)" strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" opacity={0.7} />
                    <circle cx={d.x} cy={d.to} r={3.5} fill="var(--error)" />
                  </g>
                ))}
              </g>
            )}
            {live.wires.passes.map((w) => (
              <polyline key={`${w.from}-${w.to}`} points={pts(w.points)} fill="none" stroke="var(--text3)" strokeWidth={1.6} strokeLinejoin="round" markerEnd="url(#fe-arrow)" />
            ))}
            {live.wires.fails.map((w) => (
              <polyline key={`f-${w.from}-${w.to}`} points={pts(w.points)} fill="none" stroke="var(--error)" strokeWidth={p.selected === w.from ? 2 : 1.3} strokeDasharray="6 5" strokeLinejoin="round" markerEnd="url(#fe-arrow-fail)" opacity={p.selected && p.selected !== w.from ? 0.55 : 1} />
            ))}
          </svg>
        )}

        {(() => {
          const m = p.marks?.orchestrator;
          const data: OrchestratorCardData = p.orchestrator ?? { chair: null, maxWorkers: null };
          return <OrchestratorCard flow={flow} data={data} mark={m} x={orchLeft} y={0} selected={!!m?.focus} project={p.project}
            onPress={p.onOrchestrator} onConfigure={p.onConfigureOrchestrator}
            onOpenTab={p.onOpenOrchestratorTab && data.seat?.name ? p.onOpenOrchestratorTab : undefined} />;
        })()}

        {empty ? (
          <div className="fe-empty" style={{ left: "50%", top: 200, transform: "translateX(-50%)" }} data-fe-hit>
            <div className="fe-eico"><FlowIcon name="hub" size={18} /></div>
            <h2>No blocks yet</h2>
            <p>Start from the flow agentglass ships, or drag a role from the team onto the canvas. The orchestrator is already here; the path is what you make it.</p>
            <div className="fe-tplrow">
              {p.templateNames.map((t, i) => (
                <span key={t.id} className="fe-tplfrag">{i > 0 && <span className="fe-tplar">→</span>}<span className="fe-tplchip" style={{ "--hue": `var(--${t.hue})` } as React.CSSProperties}><i />{t.name}</span></span>
              ))}
            </div>
            <div className="fe-acts">
              <button type="button" className="fe-btn" data-tone="primary" onClick={p.onUseTemplate}><FlowIcon name="spark" size={ICON.xs} />Use the default flow</button>
              <button type="button" className="fe-btn" onClick={p.onAddFirst}><FlowIcon name="plus" size={ICON.xs} />Add a block</button>
            </div>
          </div>
        ) : (
          <>
            {flow.path.map((id, i) => {
              const role = roleById(flow, id);
              const at = live.lay.places.get(id);
              if (!role || !at) return null;
              // A rule that decided this block runs it with the rule's chain, and `resolve` leaves the ask off for it.
              const ask = role.policyRole ? p.marks?.[role.policyRole]?.kind === "rule" ? false : p.ask?.[role.policyRole]?.ask ?? false : false;
              return (
                <WorkerCard key={id} role={role} flow={flow} mark={role.policyRole ? p.marks?.[role.policyRole] : undefined} ask={ask} x={at.x} y={at.y} selected={p.selected === id} dragging={drag?.id === id}
                  counts={p.counts} onPointerDown={(e) => startDrag(e, id)} onOpen={() => p.onConfigure(id)} onSelect={() => p.onSelect(id)}
                  onConfigure={() => p.onConfigure(id)} onAddAfter={() => p.onAddAfter(i + 1)} onRemove={() => p.onRemove(id)}
                  onArrow={(dir) => { const n = flow.path[i + dir]; if (n) { p.onSelect(n); document.querySelector<HTMLElement>(`[data-fe-block="${n}"]`)?.focus(); } }} />
              );
            })}
            {live.wires.passes.map((w, i) => {
              const m = gapPoint(w.points);
              return <GapPlus key={`g-${w.from}`} at={m} label={`Add a block between ${roleById(flow, w.from)?.name} and ${roleById(flow, w.to)?.name}`} onClick={() => p.onAddAt(i + 1)} />;
            })}
            {(() => {
              const last = live.lay.places.get(flow.path[flow.path.length - 1]!);
              return last ? <GapPlus at={{ x: last.x + BLOCK_W + 24, y: last.y + BLOCK_H / 2 }} label="Add a block at the end" onClick={() => p.onAddAt(flow.path.length)} /> : null;
            })()}
            {live.wires.fails.map((w) => (
              <span key={`c-${w.from}`} className="fe-fchip" data-lit={p.selected === w.from ? "" : undefined} style={{ left: w.label.x, top: w.label.y - 11, transform: "translateX(-50%)" }}>
                <FlowIcon name="undo" size={ICON.xs} />
                <span title={`After ${w.rounds} ${w.rounds === 1 ? "round" : "rounds"} it asks you.`}>fails → <b>{roleById(flow, w.to)?.name}</b> · up to {w.rounds} {w.rounds === 1 ? "try" : "tries"}</span>
              </span>
            ))}
          </>
        )}
      </div>

      <div className="fe-legend" aria-hidden="true">
        <span><i className="fe-ar" /> passes to the next</span>
        <span><i className="fe-ar fe-ar-fl" /> fails back, with its tries</span>
        <span><FlowIcon name="lock" size={12} /> must run</span>
      </div>
      <div className="fe-mini" aria-hidden="true">
        <i style={{ left: mini.orch.x, top: mini.orch.y, width: mini.orch.w, height: mini.orch.h, background: "color-mix(in srgb, var(--g-agents) 40%, transparent)" }} />
        {mini.blocks.map((b) => {
          const r = roleById(flow, b.id!);
          return <i key={b.id} style={{ left: b.x, top: b.y, width: b.w, height: b.h, background: r ? `color-mix(in srgb, ${hueVar(r)} 45%, transparent)` : undefined }} />;
        })}
        {mini.frame && <span className="fe-vp" style={{ left: mini.frame.x, top: mini.frame.y, width: mini.frame.w, height: mini.frame.h }} />}
      </div>
      <div className="fe-zoomctl" data-fe-hit>
        {p.onTidy && <button type="button" className="fe-tidy" data-tip="Grid: put every block in neat rows, in path order" aria-label="Arrange the blocks in a grid" onClick={() => { touched.current = false; p.onTidy!(); }}><FlowIcon name="grid" size={12} /></button>}
        {p.onFlowLayout && <button type="button" className="fe-tidy" data-tip="Flow: lay the path out as one natural river, each block after the one it follows" aria-label="Arrange the blocks as a flowing river" onClick={() => { touched.current = false; p.onFlowLayout!(); }}><FlowIcon name="loop" size={12} /></button>}
        <button type="button" title="Zoom out" aria-label="Zoom out" disabled={view.zoom <= ZOOM_MIN + 0.001} onClick={() => zoomTo(1 / 1.2)}><FlowIcon name="minus" size={12} /></button>
        <span className="fe-pct">{pct}%</span>
        <button type="button" title="Zoom in" aria-label="Zoom in" disabled={view.zoom >= ZOOM_MAX - 0.001} onClick={() => zoomTo(1.2)}><FlowIcon name="plus" size={12} /></button>
        <span className="fe-sep" aria-hidden="true" />
        <button type="button" title="Fit the flow in view" aria-label="Fit the flow in view" onClick={() => { touched.current = false; setView(fitView(bounds, stage)); }}><FlowIcon name="fit" size={12} /></button>
      </div>
    </section>
  );
}

const pts = (a: Pt[]) => a.map((q) => `${q.x},${q.y}`).join(" ");

/** The middle of a passing arrow: the midpoint of its one straight run, or of the run between rows. */
function gapPoint(a: Pt[]): Pt {
  const [p1, p2] = a.length === 2 ? [a[0]!, a[1]!] : [a[1]!, a[2]!];
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function GapPlus({ at, label, onClick }: { at: Pt; label: string; onClick: () => void }) {
  return (
    <button type="button" className="fe-gapplus" data-fe-hit style={{ left: at.x - 11, top: at.y - 11 }} aria-label={label} title={label}
      onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      <FlowIcon name="plus" size={12} />
    </button>
  );
}
