import { useEffect, useId, useRef, useState } from "react";
import { useNow } from "../../../lib/visibleInterval.ts";
import { Portal } from "../../Portal.tsx";
import { Badge, Button, EDGE, LINE, tintEdge } from "../../workspace/Chrome.tsx";
import { statusText } from "../../StatusPill.tsx";
import { DoneIcon, CrossIcon } from "../../../lib/glyphIcons.tsx";
import { LAYER } from "../../../lib/layers.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { CONFIRM_TIMEOUT_MS } from "./dragModel.ts";
import { confirmSub, confirmTitle, moveButtonLabel, pairGroups, pairOf, planMove, progressLine, resultToast, runDone, screenLine, skippedStep, toastHolds, type MoveItem, type RunRow, type ScreenRead } from "./moveConfirmModel.ts";
import type { MoveFacts } from "./menus/menuModel.ts";

/*
 * The board's "move these cards?" question and what follows it, as the house modal: the cards, where they stand and
 * where they go, who cannot make the step, then per-row progress with Undo, and a toast that reopens the list.
 * The decisions live in moveConfirmModel.ts; this file only draws them.
 */

const StatusBadge = ({ status, to }: { status: string; to?: boolean }) => (
  <Badge tint={to ? "var(--primary)" : "var(--text2)"} fill={to ? "var(--primary)" : "var(--text)"} wash={to ? 14 : 8} outlined tight>{statusText(status)}</Badge>
);
const Arrow = () => <span aria-hidden className="shrink-0 text-[12px]" style={{ color: "var(--text3)" }}>→</span>;

/** A modal frame that keeps the focus inside, answers Esc, and sits on the dialog layer. */
export function Frame({ labelId, onEsc, busy, children }: { labelId: string; onEsc: () => void; busy?: boolean; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEsc(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex='0']")];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [onEsc]);
  return (
    <Portal z={LAYER.settingsDialog}>
      <div className="fixed inset-0 agx-scrim" onClick={onEsc} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none">
        <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={labelId} aria-busy={busy || undefined}
          className="pointer-events-auto w-full max-w-[520px] min-w-0 rounded-xl overflow-hidden flex flex-col"
          style={{ maxHeight: "calc(100dvh - 48px)", background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px var(--shadow)" }}>
          {children}
        </div>
      </div>
    </Portal>
  );
}

export const Head = ({ id, title, sub }: { id: string; title: string; sub: string }) => (
  <div className="px-4 pt-3 pb-2 shrink-0">
    <div id={id} className="text-[16px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{title}</div>
    <div className="mt-0.5 text-[12px]" role="status" style={{ color: "var(--text3)" }}>{sub}</div>
  </div>
);
export const Foot = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 py-2.5 shrink-0 flex items-center gap-2" style={{ borderTop: LINE }}>{children}</div>
);

/** One line under a group: what the site's transition screen asks for. A failed read warns and never blocks Move. */
function ScreenLine({ read, to }: { read: ScreenRead | undefined; to: string }) {
  const l = screenLine(read, to);
  return <div className="mt-1 text-[11px]" role="status" style={{ color: l.tone === "warn" ? "var(--warning)" : l.tone === "info" ? "var(--text3)" : "var(--text2)" }}>{l.text}</div>;
}

export function MoveConfirmDialog({ items, to, moves, next, readScreen, onCancel, onMove, onDontAsk }: {
  items: readonly MoveItem[]; to: string; moves: ReadonlyMap<string, Promise<MoveFacts>>; next: string | null;
  /** One read of the move's screen for a card: called once per (project, from-status) pair. */
  readScreen: (item: MoveItem) => Promise<ScreenRead>;
  onCancel: () => void; onMove: (ids: string[]) => void; onDontAsk?: (() => void) | undefined;
}) {
  const [facts, setFacts] = useState<Map<string, MoveFacts> | null>(null);
  const [skip, setSkip] = useState(false);
  const [screens, setScreens] = useState<Record<string, ScreenRead>>({});
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    let live = true;
    void Promise.all(items.map(async (c) => [c.id, await (moves.get(c.id) ?? Promise.resolve({ error: "" } as MoveFacts))] as const)).then((e) => { if (live) setFacts(new Map(e)); });
    return () => { live = false; };
  }, [items, moves]);
  // The board re-renders often and hands a new `items` each time: the read follows the pairs, not the array.
  const latest = useRef({ items, readScreen });
  latest.current = { items, readScreen };
  const pairsKey = pairGroups(items).map((g) => g.pair).join("\n");
  useEffect(() => {
    let live = true;
    for (const g of pairGroups(latest.current.items)) {
      void latest.current.readScreen(g.rep).catch((): ScreenRead => ({ phase: "failed", error: "" })).then((r) => { if (live) setScreens((s) => ({ ...s, [g.pair]: r })); });
    }
    return () => { live = false; };
  }, [pairsKey]);
  useEffect(() => { const t = setTimeout(() => cancelRef.current?.focus(), 30); return () => clearTimeout(t); }, []);
  const plan = facts ? planMove(items, facts, to) : null;
  const single = items.length === 1;
  const n = plan?.movable.length ?? 0;
  const skipped = single ? skippedStep(next, to) : null;
  return (
    <Frame labelId={id} onEsc={onCancel}>
      <Head id={id} title={confirmTitle(items.length, to, items[0]?.key ?? "")} sub={plan ? confirmSub(plan) : "Reading the steps…"} />
      <div className="agx-dialog-body px-4 pb-3 flex-1 min-h-0 overflow-y-auto" tabIndex={0} aria-label="Cards to move">
        {single && items[0] && (
          <>
            <div className="flex items-baseline gap-2 rounded-lg px-2.5 py-2" style={{ background: "var(--surface-inset)", border: EDGE }}>
              <span className="text-[11px]" style={{ fontFamily: "var(--mono, monospace)", color: "var(--text3)" }}>{items[0].key}</span>
              <span className="flex-1 min-w-0 truncate text-[13px]" style={{ color: "var(--text)" }}>{items[0].title}</span>
            </div>
            <div className="flex items-center gap-2 my-2.5"><StatusBadge status={items[0].from} /><Arrow /><StatusBadge status={to} to /><span className="sr-only">from {statusText(items[0].from)} to {statusText(to)}</span></div>
            <ScreenLine read={screens[pairOf(items[0])]} to={to} />
            {skipped && <p className="text-[12px] m-0" style={{ color: "var(--text2)" }}><span aria-hidden style={{ color: "var(--warning)", fontWeight: 700 }}>! </span>Skips <b>{statusText(skipped)}</b>: this goes straight to {statusText(to)}.</p>}
          </>
        )}
        {!single && plan?.groups.map((g) => (
          <div key={g.from} className="mt-2.5 first:mt-0">
            <div className="flex items-center gap-2 text-[11px] mb-1" style={{ color: "var(--text3)" }}><StatusBadge status={g.from} /> {g.items.length} card{g.items.length === 1 ? "" : "s"}</div>
            <ScreenLine read={screens[pairOf(g.items[0]!)]} to={to} />
            {g.items.map((c) => (
              <div key={c.id} className="grid items-center gap-2 py-1 text-[12px]" style={{ gridTemplateColumns: "70px 1fr auto", borderBottom: LINE }}>
                <span className="text-[11px]" style={{ fontFamily: "var(--mono, monospace)", color: "var(--text3)" }}>{c.key}</span>
                <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{c.title}</span>
                <span className="flex items-center gap-1.5"><StatusBadge status={c.from} /><Arrow /><StatusBadge status={to} to /></span>
              </div>
            ))}
          </div>
        ))}
        {plan && plan.blocked.length > 0 && (
          <div className="mt-3 rounded-lg px-2.5 py-2" style={{ border: tintEdge("var(--warning)", 50), background: "color-mix(in srgb, var(--warning) 9%, var(--bg2))" }}>
            <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--warning)" }}>{single ? "Cannot move" : "Cannot move · stays where it is"}</div>
            {plan.blocked.map((b) => (
              <div key={b.id} className="py-0.5 text-[12px]">
                <div className="flex items-center gap-2"><span className="text-[11px]" style={{ fontFamily: "var(--mono, monospace)", color: "var(--text3)" }}>{b.key}</span><span className="flex-1 min-w-0 truncate" style={{ color: "var(--text2)" }}>{b.title}</span><StatusBadge status={b.from} /></div>
                <div className="text-[11px]" style={{ color: "var(--warning)" }}>{b.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Foot>
        {single && onDontAsk ? (
          <label className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: "var(--text3)" }}>
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} style={{ accentColor: "var(--primary)" }} /> Don't ask again for single moves
          </label>
        ) : <span className="text-[12px]" style={{ color: "var(--text3)" }}>{single ? "" : "Several cards always ask."}</span>}
        <span className="flex-1" />
        <Button buttonRef={cancelRef} onClick={onCancel}>Cancel</Button>
        <Button tone="primary" disabled={!plan || n === 0} onClick={() => { if (skip) onDontAsk?.(); onMove(plan!.movable.map((c) => c.id)); }}>{moveButtonLabel(n || 1)}</Button>
      </Foot>
    </Frame>
  );
}

/** The run: every row says moving, moved, or failed with the site's reason; Undo puts the moved ones back until the house window closes. */
export function MoveRunDialog({ items, to, rows, endedAt, onUndo, onClose }: {
  items: readonly MoveItem[]; to: string; rows: Readonly<Record<string, RunRow>>; endedAt: number | null; onUndo: (ids: string[]) => void; onClose: () => void;
}) {
  const id = useId();
  const list = items.map((c) => rows[c.id]).filter((r): r is RunRow => !!r);
  const done = runDone(list);
  const now = useNow(!!endedAt, 500);
  const left = endedAt ? Math.max(0, Math.ceil((endedAt + CONFIRM_TIMEOUT_MS - now) / 1000)) : CONFIRM_TIMEOUT_MS / 1000;
  const movedIds = items.filter((c) => rows[c.id]?.phase === "moved").map((c) => c.id);
  const canUndo = done && movedIds.length > 0 && left > 0;
  const total = list.length || 1;
  const settled = list.filter((r) => r.phase !== "moving").length;
  return (
    <Frame labelId={id} onEsc={onClose} busy={!done}>
      <Head id={id} title={`${done ? "Moved" : "Moving"} ${items.length} card${items.length === 1 ? "" : "s"} to ${statusText(to)}`} sub={progressLine(list)} />
      <div className="agx-dialog-body px-4 pb-3 flex-1 min-h-0 overflow-y-auto" tabIndex={0} aria-label="Move progress">
        {items.map((c) => {
          const r = rows[c.id];
          return (
            <div key={c.id} className="grid items-center gap-2 py-1 text-[12px]" style={{ gridTemplateColumns: "70px 1fr auto", borderBottom: LINE }}>
              <span className="text-[11px]" style={{ fontFamily: "var(--mono, monospace)", color: "var(--text3)" }}>{c.key}</span>
              <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{c.title}</span>
              <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap" style={{ color: r?.phase === "moved" ? "var(--success)" : r?.phase === "failed" ? "var(--error)" : "var(--text3)" }}>
                {r?.phase === "moved" && <><DoneIcon size={ICON.xs} /> Moved</>}
                {r?.phase === "failed" && <><CrossIcon size={ICON.xs} /> Failed</>}
                {r?.phase === "undone" && <>Put back</>}
                {(!r || r.phase === "moving") && <>Moving…</>}
              </span>
              {r?.phase === "failed" && r.reason && <span className="text-[11px]" style={{ gridColumn: "2 / 4", color: "var(--error)" }}>{r.reason}</span>}
            </div>
          );
        })}
        <div className="mt-2.5 h-[3px] rounded-sm overflow-hidden" style={{ background: "var(--bg3)" }} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={settled}>
          <div className="h-full" style={{ width: `${(settled / total) * 100}%`, background: "var(--primary)", transition: "width 160ms var(--ease-out)" }} />
        </div>
      </div>
      <Foot>
        <span className="text-[12px]" style={{ color: "var(--text3)" }}>{canUndo ? `Undo available for ${left} s` : done ? "" : "Writing to Jira…"}</span>
        <span className="flex-1" />
        <Button disabled={!canUndo} onClick={() => onUndo(movedIds)}>{movedIds.length ? `Undo ${movedIds.length} moved` : "Undo"}</Button>
        <Button tone="primary" onClick={onClose}>Close</Button>
      </Foot>
    </Frame>
  );
}

/** What a finished run leaves behind: the counts, and Show to reopen the list. Holds while something failed. */
export function MoveResultToast({ rows, onShow, onDismiss }: { rows: readonly RunRow[]; onShow: () => void; onDismiss: () => void }) {
  const holds = toastHolds(rows);
  useEffect(() => { if (holds) return; const t = setTimeout(onDismiss, CONFIRM_TIMEOUT_MS); return () => clearTimeout(t); }, [holds, onDismiss]);
  return (
    <Portal z={LAYER.settingsDialog}>
      <div role="status" className="fixed flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12px]"
        style={{ right: 16, bottom: 48, maxWidth: 420, background: "var(--surface-card)", border: EDGE, boxShadow: "0 10px 30px var(--shadow)", color: "var(--text)" }}>
        <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: holds ? "var(--warning)" : "var(--success)" }} />
        <span className="font-semibold">{resultToast(rows)}</span>
        <Button size="compact" onClick={onShow}>Show</Button>
        {holds && <Button size="compact" aria-label="Dismiss" onClick={onDismiss}><CrossIcon size={ICON.xs} /></Button>}
      </div>
    </Portal>
  );
}
