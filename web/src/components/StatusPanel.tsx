import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { Button, INPUT, INPUT_STYLE, LINE } from "./workspace/Chrome.tsx";
import { CaretIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import { placeMenu } from "../lib/menuPlacement.ts";
import type { Nouns } from "../lib/workflowMap.ts";
import { pickView, type Partition, type PickGroup, type PickRow } from "../lib/workflowLayout.ts";

/** What the status list is doing: the four states the picker has a face for. */
export type PanelView =
  | { kind: "ok" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; text: string };

/** The dot a status wears: its own colour when the tracker sent one, else its type's. */
export const TYPE_DOT: Record<string, string> = { open: "#87909e", custom: "#4194f6", done: "#6bc950", closed: "#008844" };
export const dotColor = (type: string, color?: string): string => color || TYPE_DOT[type] || TYPE_DOT.custom!;
export function Dot({ type, color }: { type: string; color?: string }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: 8, height: 8, background: dotColor(type, color) }} />;
}

/**
 * The searchable list of the user's own statuses: a combobox over a listbox, grouped by
 * the list each status lives in.
 *
 * Shared by the popover on a step's control, so a status is chosen one way. Each group is
 * a counted list with its folder under it, each status carries a bar per counted list
 * that has it, and the lists that do not count wait in a fold below the scroll. A search
 * reaches into the fold and opens it. Nothing is offered that the tracker did not send: a
 * query with no match says so and offers to clear itself. A pick costs no request, because
 * the statuses are already on screen.
 *
 * Keys: Up/Down move, Enter picks, Esc closes. The highlighted row is reported up so the
 * status column can light the same status in the list being looked at.
 */
export function StatusPanel({ nouns, part, view, current, leave, suggested, source, onPick, onClose, onActive, onRetry, autoFocus = true }: {
  nouns: Nouns;
  part: Partition;
  view: PanelView;
  /** The status now chosen; null or "" is "none". */
  current?: string | null;
  /** Offer "Leave it there" as the first row (the merge choice, where no status is an answer). */
  leave?: boolean;
  suggested?: string | null;
  /** One line under the list: where these statuses come from and how old they are. */
  source?: ReactNode;
  onPick: (status: string | null) => void;
  onClose?: () => void;
  onActive?: (status: string | null) => void;
  onRetry?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const cur = (current ?? "").toLowerCase();
  /* A chosen status that only a folded list has opens the fold, or the check mark would be out of sight. */
  const [foldOpen, setFoldOpen] = useState(() => !!cur && !part.counted.some((u) => u.statuses.some((x) => x.status.toLowerCase() === cur)) && part.folded.some((f) => f.unit.statuses.some((x) => x.status.toLowerCase() === cur)));
  const pv = useMemo(() => pickView(part, q, foldOpen), [part, q, foldOpen]);
  const shown = useMemo<{ key: string; name: string | null }[]>(
    () => (view.kind === "ok" || view.kind === "error" ? [...(leave && !q.trim() ? [{ key: "\u0000leave", name: null }] : []), ...pv.order] : []),
    [view.kind, leave, q, pv],
  );
  const [act, setAct] = useState(() => {
    const at = shown.findIndex((o) => (o.name === null ? !cur : o.name.toLowerCase() === cur));
    return Math.max(0, at);
  });
  const inputRef = useRef<HTMLInputElement>(null);
  /* Next frame, not at mount: inside the popover the panel mounts in the same commit that
     positions it, and a focus call in that commit lands before the browser has the box. */
  useEffect(() => {
    if (!autoFocus) return;
    const r = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(r);
  }, [autoFocus]);
  useEffect(() => { onActive?.(view.kind === "ok" && shown[act] ? shown[act]!.name : null); }, [act, view.kind, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onActive?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.getElementById(`${id}-o${act}`)?.scrollIntoView({ block: "nearest" }); }, [act, id]);

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAct((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAct((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && view.kind === "ok" && shown.length) { e.preventDefault(); onPick(shown[act]?.name ?? null); }
    else if (e.key === "Escape" && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  const msg = (title: string, body: ReactNode, action?: ReactNode, role?: "alert") => (
    <div role={role} className="px-2 py-3 flex flex-col gap-2 items-start text-[11px]" style={{ color: "var(--text3)" }}>
      <b className="text-[13px]" style={{ color: role === "alert" ? "var(--error-ink)" : "var(--text)" }}>{title}</b>
      <span>{body}</span>
      {action}
    </div>
  );
  const idx = (k: string) => shown.findIndex((o) => o.key === k);
  const row = (g: PickGroup, r: PickRow) => {
    const k = `${g.unit.id}:${r.name}`, i = idx(k);
    const selected = r.name.toLowerCase() === cur;
    return (
      <div key={k} id={`${id}-o${i}`} role="option" aria-selected={selected} tabIndex={-1} className="wfm-opt" {...(act === i ? { "data-act": "" } : {})}
        onMouseMove={() => { if (act !== i) setAct(i); }} onClick={() => onPick(r.name)}>
        <span className="ck" aria-hidden>{selected ? <DoneIcon size={ICON.xs} /> : null}</span>
        <Dot type={r.type} color={r.color} />
        <span className="n">{r.name}</span>
        {suggested === r.name && <span className="shrink-0 rounded-full px-1.5 text-[10px]" style={{ background: "var(--w-wash2)", color: "var(--primary-ink)" }}>suggested</span>}
        {g.ignored ? <span className="m">0 of {part.counted.length} {nouns.lists}</span>
          : <span className="wfm-segs" title={part.counted.map((c, n) => `${c.name}: ${r.bars[n] ? "yes" : "no"}`).join(" · ")}>{r.bars.map((y, n) => <i key={n} {...(y ? { "data-y": "" } : {})} />)}</span>}
      </div>
    );
  };
  const group = (g: PickGroup) => (
    <div key={g.unit.id} className="wfm-grp" role="group" aria-label={g.unit.name}>
      <div className="wfm-gh"><b>{g.unit.name}</b><span className="text-[11px]" style={{ color: "var(--text3)" }}>{g.ignored ? "ignored" : g.unit.group}</span></div>
      {g.rows.map((r) => row(g, r))}
    </div>
  );
    const empty = pv.groups.length + pv.folded.length === 0;
  const body = view.kind === "ok" || (view.kind === "error" && part.counted.length > 0);
  return (
    <div onKeyDown={key} className="wfm wfm-pop">
      <div className="flex items-center gap-2">
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={`${id}-l`} aria-label="Search your statuses"
          aria-activedescendant={view.kind === "ok" && shown.length ? `${id}-o${act}` : undefined}
          value={q} onChange={(e) => { setQ(e.target.value); setAct(0); }}
          placeholder="Search your statuses" spellCheck={false} autoComplete="off"
          className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
      </div>
      {view.kind === "loading" && (
        <div aria-busy="true" id={`${id}-l`} className="p-1.5">
          {[70, 55, 80, 45, 62].map((w, i) => <div key={i} className="px-2 py-1.5"><div className="agx-skel rounded" style={{ width: `${w}%`, height: 12, background: "var(--surface-inset)" }} /></div>)}
          <div className="px-2 pb-1 pt-1 text-[11px]" style={{ color: "var(--text3)" }}>Reading statuses from {nouns.name}…</div>
        </div>
      )}
      {view.kind === "empty" && msg("No statuses we can read.", `${nouns.name} returned none for this ${nouns.workspace}, or this token cannot see them.`, onRetry && <Button size="compact" onClick={onRetry}>Re-read</Button>)}
      {view.kind === "error" && msg(view.text, "Nothing was changed and your steps are untouched. What is below was read earlier; it cannot be picked until this clears.", onRetry && <Button size="compact" onClick={onRetry}>Try again</Button>, "alert")}
      {body && (empty && q.trim()
        ? msg(`No status matches “${q.trim()}”.`, `Only statuses ${nouns.name} returned are listed. Nothing is invented.`, <Button size="compact" onClick={() => { setQ(""); setAct(0); inputRef.current?.focus(); }}>Clear search</Button>)
        : (
          <div style={view.kind === "error" ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <div id={`${id}-l`} role="listbox" aria-label="Your statuses" className="wfm-lst agx-scroll">
              {leave && !q.trim() && (
                <div id={`${id}-o0`} role="option" aria-selected={!cur} tabIndex={-1} className="wfm-opt" {...(act === 0 ? { "data-act": "" } : {})}
                  onMouseMove={() => { if (act !== 0) setAct(0); }} onClick={() => onPick(null)}>
                  <span className="ck" aria-hidden>{!cur ? <DoneIcon size={ICON.xs} /> : null}</span>
                  <span aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, border: "1px dashed var(--text3)" }} />
                  <span className="n">Leave it there</span><span className="m">no status</span>
                </div>
              )}
              {pv.groups.map(group)}
              {pv.foldedOpen && pv.folded.map(group)}
            </div>
            {pv.folded.length > 0 && !pv.foldedOpen && (
              <button type="button" aria-expanded={false} onClick={() => setFoldOpen(true)} className="wfm-fold w-full" style={{ background: "none", border: 0, borderTop: LINE, marginTop: 4, padding: 0, textAlign: "left", cursor: "pointer", color: "var(--text)" }}>
                <span className="flex gap-2 items-center min-h-[32px] px-2 text-[13px]"><span className="chev" aria-hidden><CaretIcon size={ICON.xs} /></span><b>Ignored ({pv.folded.length})</b><span className="text-[11px]" style={{ color: "var(--text3)" }}>not counted</span></span>
              </button>
            )}
          </div>
        ))}
      {view.kind === "ok" && source && <div className="px-2 pt-2 text-[11px]" style={{ borderTop: LINE, color: "var(--text3)" }}>{source}</div>}
    </div>
  );
}

/** The same panel, floating under the control that opened it. Closes on a press outside; Esc hands focus back. */
export function StatusPopover({ anchor, label, onClose, children }: { anchor: HTMLElement; label: string; onClose: (refocus: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /* Placed with the list's real height, against the trigger as it is NOW: a guess of the height put a short
     list ~400px above its button, and a position taken once went stale as soon as the Settings scroller moved.
     Measured after the portal is attached (see AnchoredMenu), and again when the page scrolls or the list's
     height changes (a search narrowing it). */
  useEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const p = placeMenu(anchor.getBoundingClientRect(), { width: 380, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, "left");
      setPos((cur) => (cur && cur.left === p.left && cur.top === p.top ? cur : { left: p.left, top: p.top }));
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" && ref.current ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { ro?.disconnect(); document.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [anchor]);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose(false);
    };
    /* Esc from inside the popover is the panel's own business; Esc with focus anywhere else still closes it. */
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !ref.current?.contains(document.activeElement)) onClose(true); };
    document.addEventListener("mousedown", out, true);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", out, true); document.removeEventListener("keydown", esc, true); };
  }, [anchor, onClose]);
  return (
    <Portal z={LAYER.settingsDialog}>
      <div ref={ref} role="dialog" aria-label={label} className="fixed" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: 380, boxShadow: "var(--surface-lift)", borderRadius: 12, visibility: pos ? "visible" : "hidden" }}>
        {children}
      </div>
    </Portal>
  );
}
