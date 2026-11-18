/*
 * The Flow editor's list view: the path as one column of steps, each with a
 * grip. Drag the grip, or focus it and press Space, the arrows, Space again;
 * Esc cancels. Every decision (which places are allowed, why one is refused,
 * what a drop does) is `flowMove.ts`; this only paints it and calls back with
 * the new flow, so the list, the board and the canvas are one value.
 *
 * "You" (the asker) is drawn first and the Gate last, both locked. A refused
 * place is a dashed red row with its reason; the drop slot is blue.
 */
import { useRef, useState } from "react";
import { roleById, type Flow } from "../../../../../shared/flow.ts";
import { dropSlots, floatBox, lockedWhy, moveTo, removeWhy, slotFromMids, type Box } from "../../../lib/flowMove.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { railModel, runsOn } from "./flowScreenCopy.ts";

type Lift = { id: string; index: number; how: "pointer" | "key"; y: number; dy: number; row: Box; /** Midpoints of the other rows when the drag began; the drop slot shifts the live ones. */ mids: number[] };

export function FlowList(p: {
  flow: Flow;
  onMove: (next: Flow) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
  /** Said under the list while a drop is refused or a step cannot be deleted. */
  onNote?: (text: string | null) => void;
}) {
  const [lift, setLift] = useState<Lift | null>(null);
  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const listEl = useRef<HTMLDivElement>(null);
  /** The lift of a row at a pointer or key: where its row is, so the floating card keeps that column and size. */
  const lifting = (id: string, how: Lift["how"], y: number): Lift => {
    const b = rows.current.get(id)?.getBoundingClientRect();
    const row = b ? { left: b.left, top: b.top, width: b.width, height: b.height } : { left: 0, top: 0, width: 0, height: 0 };
    const mids = p.flow.path.filter((x) => x !== id).map((x) => { const r = rows.current.get(x)?.getBoundingClientRect(); return r ? r.top + r.height / 2 : 0; });
    return { id, index: p.flow.path.indexOf(id), how, y, dy: Math.max(0, Math.min(row.height, y - row.top)), row, mids };
  };
  const slots = lift ? dropSlots(p.flow, lift.id) : [];
  const rest = lift ? p.flow.path.filter((x) => x !== lift.id) : p.flow.path;

  const drop = () => {
    if (!lift) return;
    const r = moveTo(p.flow, lift.id, lift.index);
    if (r.ok) { if (p.flow.path.indexOf(lift.id) !== lift.index) p.onMove(r.flow); p.onNote?.(null); }
    else p.onNote?.(r.error);
    setLift(null);
  };
  const cancel = () => { setLift(null); p.onNote?.(null); };

  const gap = (index: number) => {
    if (!lift) return null;
    const s = slots.find((x) => x.index === index);
    if (!s || lift.index !== index) return null;
    return s.ok
      ? <div key="slot" className="fl-slot" role="status">Drop here: step {index + 2}{rest[index] ? `, before ${roleById(p.flow, rest[index]!)?.name ?? ""}` : ", last"}</div>
      : <div key="slot" className="fl-slot" data-refused role="alert">{s.why}</div>;
  };

  const row = (id: string, i: number) => {
    const role = roleById(p.flow, id);
    if (!role) return null;
    const on = runsOn(role);
    const locked = lockedWhy(p.flow, id);
    const lifted = lift?.id === id;
    const del = removeWhy(p.flow, id);
    return (
      <div key={id} ref={(el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }} className="fl-row" data-lifted={lifted ? lift?.how : undefined}
        style={{ "--hue": `var(--${role.hue})` } as React.CSSProperties}>
        {locked
          ? <span className="fl-grip" data-locked data-tip={locked} aria-label={locked}><FlowIcon name="lock" size={ICON.xs} /></span>
          : <button type="button" className="fl-grip" aria-label={`Move ${role.name}, step ${i + 2} of ${p.flow.path.length + 1}. Space lifts it, arrows choose a place, Space drops it, Esc cancels.`}
              aria-pressed={lifted && lift?.how === "key"} data-tip={"Drag to move"}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setLift(lifting(id, "pointer", e.clientY));
              }}
              onPointerMove={(e) => { if (lift?.how === "pointer" && lifted) setLift({ ...lift, index: slotFromMids(lift.mids, e.clientY), y: e.clientY }); }}
              onPointerUp={() => { if (lift?.how === "pointer") drop(); }}
              onPointerCancel={cancel}
              onKeyDown={(e) => {
                if (e.key === " ") { e.preventDefault(); if (lift?.how === "key" && lifted) drop(); else setLift(lifting(id, "key", 0)); }
                else if (e.key === "Escape" && lifted) { e.preventDefault(); e.stopPropagation(); cancel(); }
                else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && lift?.how === "key" && lifted) {
                  e.preventDefault();
                  const to = lift.index + (e.key === "ArrowUp" ? -1 : 1);
                  const ok = slots.find((x) => x.index === to)?.ok;
                  if (ok) { setLift({ ...lift, index: to }); p.onNote?.(null); }
                  else if (slots.some((x) => x.index === to)) setLift({ ...lift, index: to });
                }
              }}
              onBlur={() => { if (lift?.how === "key" && lifted) cancel(); }}><FlowIcon name="grip" size={ICON.xs} /></button>}
        <span className="fl-n">{i + 2}</span>
        <div className="fl-body" role="button" tabIndex={0} aria-label={`${role.name}. Enter configures it.`}
          onClick={() => p.onConfigure(id)} onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") p.onConfigure(id); }}>
          <b>{role.name}</b>
          <small>{role.does}{on ? ` · ${on.engine} · ${railModel(on.model)}` : ""}</small>
        </div>
        {locked && <small className="fl-why">{locked}</small>}
        <span className="fe-chip" data-required={role.required ? "" : undefined}>{role.required ? "Required" : "Optional"}</span>
        <button type="button" className="fe-sq" disabled={!!del} aria-label={`Take ${role.name} off the path`} data-tip={del ?? "Take off the path; it stays in the team"}
          onClick={() => p.onRemove(id)}><FlowIcon name="x" size={ICON.xs} /></button>
      </div>
    );
  };

  let at = 0;
  const kids: React.ReactNode[] = [];
  p.flow.path.forEach((id, i) => {
    if (id !== lift?.id) kids.push(gap(at++));
    kids.push(row(id, i));
  });
  kids.push(gap(at));
  // The card in the hand: only while a pointer drags; the keyboard's lifted row is drawn as a card in its own place.
  const held = lift?.how === "pointer" ? roleById(p.flow, lift.id) : undefined;
  const lb = listEl.current?.getBoundingClientRect();
  const card = lift && held && lb ? floatBox(lift.row, lift.y, lift.dy, { top: lb.top, bottom: lb.bottom }) : null;
  return (
    <div className="fl-list" ref={listEl} role="list" aria-label="Flow steps" onKeyDown={(e) => { if (e.key === "Escape" && lift) cancel(); }}>
      <div className="fl-row fl-you" data-fixed>
        <span className="fl-grip" data-locked aria-hidden="true"><FlowIcon name="lock" size={ICON.xs} /></span>
        <span className="fl-n">1</span>
        <div className="fl-body"><b>You</b><small>Ask for the work</small></div>
        <small className="fl-why">Always first: it is who asks.</small>
        <span className="fe-chip" data-required>Required</span>
      </div>
      {kids}
      {card && held && (
        <div className="fl-row fl-float" aria-hidden="true" style={{ "--hue": `var(--${held.hue})`, left: card.left, top: card.top, width: card.width, height: card.height } as React.CSSProperties}>
          <span className="fl-grip"><FlowIcon name="grip" size={ICON.xs} /></span>
          <span className="fl-n">{p.flow.path.indexOf(lift!.id) + 2}</span>
          <div className="fl-body"><b>{held.name}</b><small>{held.does}</small></div>
        </div>
      )}
    </div>
  );
}
