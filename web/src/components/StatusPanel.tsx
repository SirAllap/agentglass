import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { Button, EDGE, INPUT, INPUT_STYLE, LINE } from "./workspace/Chrome.tsx";
import { SearchIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import { filterStatuses, reach, type Listed, type MapSpace, type Nouns } from "../lib/workflowMap.ts";

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
 * The searchable list of the user's own statuses: a combobox over a listbox.
 *
 * Shared by the popover on a step's chip and by the composer, so the two cannot
 * disagree about how a status is chosen. Nothing is offered that the tracker did
 * not send: a query with no match says so and offers to clear itself. A pick costs
 * no request, because the statuses are already on screen.
 *
 * Keys: ↑↓ move, Enter picks, Esc closes. The highlighted row is reported up so
 * the lane can light the same status in the space being looked at.
 */
export function StatusPanel({ nouns, spaces, listed, view, current, leave, suggested, onPick, onClose, onActive, onRetry, autoFocus = true }: {
  nouns: Nouns;
  spaces: readonly MapSpace[];
  listed: readonly Listed[];
  view: PanelView;
  /** The status now chosen; null or "" is "none". */
  current?: string | null;
  /** Offer "Leave it there" as the first row (the merge choice, where no status is an answer). */
  leave?: boolean;
  suggested?: string | null;
  onPick: (status: string | null) => void;
  onClose?: () => void;
  onActive?: (status: string | null) => void;
  onRetry?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  /* Opens on the status already chosen, so Enter keeps it and the arrows start from where you are. */
  const [act, setAct] = useState(() => {
    const names = [...(leave ? [null] : []), ...listed.map((r) => r.name)];
    const at = names.findIndex((n) => (n === null ? !current : n.toLowerCase() === (current ?? "").toLowerCase()));
    return Math.max(0, at);
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => filterStatuses(listed, q), [listed, q]);
  const options = useMemo<(string | null)[]>(() => [...(leave && !q.trim() ? [null] : []), ...rows.map((r) => r.name)], [leave, q, rows]);
  const shown = view.kind === "ok" || view.kind === "error" ? options : [];
  /* Next frame, not at mount: inside the popover the panel mounts in the same commit that
     positions it, and a focus call in that commit lands before the browser has the box. */
  useEffect(() => {
    if (!autoFocus) return;
    const r = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(r);
  }, [autoFocus]);
  useEffect(() => { onActive?.(view.kind === "ok" && shown[act] !== undefined ? shown[act] ?? null : null); }, [act, view.kind, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onActive?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.getElementById(`${id}-o${act}`)?.scrollIntoView({ block: "nearest" }); }, [act, id]);

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAct((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAct((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && view.kind === "ok" && shown.length) { e.preventDefault(); onPick(shown[act] ?? null); }
    else if (e.key === "Escape" && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  const cur = (current ?? "").toLowerCase();
  const msg = (title: string, body: ReactNode, action?: ReactNode, role?: "alert") => (
    <div role={role} className="px-3.5 py-4 flex flex-col gap-2 items-start text-[12px]" style={{ color: "var(--text3)" }}>
      <b style={{ color: role === "alert" ? "var(--error-ink)" : "var(--text)", fontWeight: 600 }}>{title}</b>
      <span>{body}</span>
      {action}
    </div>
  );

  return (
    <div onKeyDown={key} className="rounded-xl overflow-hidden" style={{ background: "var(--surface-card)", border: EDGE }}>
      <div className="flex items-center gap-2 p-1.5" style={{ borderBottom: LINE }}>
        <span aria-hidden className="flex pl-1" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={`${id}-l`} aria-label="Search statuses"
          aria-activedescendant={view.kind === "ok" && shown.length ? `${id}-o${act}` : undefined}
          value={q} onChange={(e) => { setQ(e.target.value); setAct(0); }}
          placeholder="Search your statuses" spellCheck={false} autoComplete="off"
          className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
      </div>
      {view.kind === "loading" && (
        <div aria-busy="true" id={`${id}-l`} className="p-1.5">
          {[70, 55, 80, 45, 62].map((w, i) => <div key={i} className="px-2 py-1.5"><div className="agx-skel rounded" style={{ width: `${w}%`, height: 12, background: "var(--surface-inset)" }} /></div>)}
          <div className="px-2 pb-1 pt-1 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading statuses from {nouns.name}…</div>
        </div>
      )}
      {view.kind === "empty" && msg("No statuses we can read.", `${nouns.name} returned none for this ${nouns.workspace}, or this token cannot see them.`, onRetry && <Button size="compact" onClick={onRetry}>Re-read</Button>)}
      {view.kind === "error" && msg(view.text, "Nothing was changed and your steps are untouched. What is below was read earlier; it cannot be picked until this clears.", onRetry && <Button size="compact" onClick={onRetry}>Try again</Button>, "alert")}
      {(view.kind === "ok" || (view.kind === "error" && listed.length > 0)) && (
        shown.length === 0 && q.trim()
          ? msg(`No status matches “${q.trim()}”.`, `Statuses are the ones in your ${nouns.spaces}; nothing is invented.`, <Button size="compact" onClick={() => { setQ(""); setAct(0); inputRef.current?.focus(); }}>Clear search</Button>)
          : (
            <div id={`${id}-l`} role="listbox" aria-label="Your statuses" className="p-1 overflow-y-auto agx-scroll"
              style={{ maxHeight: 260, ...(view.kind === "error" ? { opacity: 0.5, pointerEvents: "none" } : null) }}>
              {shown.map((name, i) => {
                const r = name === null ? null : listed.find((x) => x.name === name)!;
                const ra = r ? reach(spaces, r.name, nouns.spaces) : null;
                const selected = name === null ? !cur : !!r && r.name.toLowerCase() === cur;
                return (
                  <div key={name ?? "\u0000leave"} id={`${id}-o${i}`} role="option" aria-selected={selected}
                    onMouseMove={() => { if (act !== i) setAct(i); }} onClick={() => onPick(name)}
                    className="flex items-center gap-2 px-2 rounded-lg cursor-pointer text-[12px] min-h-[28px]"
                    title={r ? `In: ${r.in.join(", ")}` : undefined}
                    style={{
                      background: selected ? "color-mix(in srgb, var(--primary) 16%, transparent)" : act === i ? "color-mix(in srgb, var(--text) 6%, transparent)" : undefined,
                      boxShadow: act === i ? "inset 0 0 0 1.5px var(--primary)" : undefined, color: "var(--text)",
                    }}>
                    {r ? <Dot type={r.type} color={r.color} /> : <span aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, border: "1px dashed var(--text3)" }} />}
                    <span className="truncate">{r ? r.name : "Leave it there"}</span>
                    {r && suggested === r.name && <span className="shrink-0 rounded-full px-1.5 text-[9.5px]" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", color: "var(--primary-ink)" }}>suggested</span>}
                    <span className="ml-auto shrink-0 text-[10px]" style={{ color: ra?.partial ? "var(--warning-ink)" : "var(--text3)" }}>{ra ? ra.text : "no status"}</span>
                  </div>
                );
              })}
            </div>
          )
      )}
      {view.kind === "ok" && (
        <div className="px-2.5 py-1.5 flex gap-3 flex-wrap text-[10.5px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> pick</span><span><kbd>Esc</kbd> close</span>
        </div>
      )}
    </div>
  );
}

/** The same panel, floating under the control that opened it. Closes on a press outside; Esc hands focus back. */
export function StatusPopover({ anchor, label, onClose, children }: { anchor: HTMLElement; label: string; onClose: (refocus: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 340;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 16));
    const room = window.innerHeight - r.bottom;
    /* Flip above when below cannot hold a list; the chips near the bottom of a long page are the ones that need it. */
    setPos({ left, top: room < 340 && r.top > room ? Math.max(8, r.top - 4 - 330) : r.bottom + 4 });
  }, [anchor]);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose(false);
    };
    document.addEventListener("mousedown", out, true);
    return () => document.removeEventListener("mousedown", out, true);
  }, [anchor, onClose]);
  if (!pos) return null;
  return (
    <Portal z={LAYER.settingsDialog}>
      <div ref={ref} role="dialog" aria-label={label} className="fixed" style={{ left: pos.left, top: pos.top, width: 340, boxShadow: "var(--surface-lift)", borderRadius: 12 }}>
        {children}
      </div>
    </Portal>
  );
}
