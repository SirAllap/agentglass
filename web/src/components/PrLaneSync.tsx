/*
 * "Sync N" in a lane header, and the list it opens.
 *
 * The count IS the button (direction A of the mockup): pressing it opens a
 * 341px list anchored under the lane header, in the lane's own colour, with the
 * pull requests this lane will update, the ones it will leave alone folded at
 * the bottom, and one confirm. It closes back to the same button.
 *
 * What it is allowed to touch is decided in lib/prSyncLane.ts, from the card's
 * own Update rules; this file draws it and runs it. The action is the card's:
 * merge the base into the branch on GitHub, fast-forward the local copy only
 * when it is clean. Three at a time, one failure never stops the rest.
 *
 * Keyboard: the popover takes focus when it opens, Tab cycles inside it, Esc
 * closes and puts focus back on the button that opened it.
 */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Portal } from "./Portal.tsx";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { LAYER } from "../lib/layers.ts";
import { ICON } from "../lib/iconSize.ts";
import { Button, EDGE } from "./workspace/Chrome.tsx";
import { DoneIcon, RefreshIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { CODE_FONT_STYLE } from "./diff/DiffLines.tsx";
import { confirmLabel, confirmOff, laneSyncPlan, mergeResult, retryFromRow, retryItems, retryRow, runLaneSync, serialRetry, syncTally, withoutResults, SYNC_AT_ONCE, SYNC_REASON, type SyncItem, type SyncResult } from "../lib/prSyncLane.ts";
import type { SyncCardStep } from "../lib/prSyncCards.ts";
import type { LaneId } from "../lib/prLanes.ts";
import type { PrSummary } from "../../../shared/types.ts";

/** The list's width, from the mockup: four rows of #number + title fit, and it stays narrower than a lane. */
export const SYNC_POP_WIDTH = 341;

export interface LaneSyncRow {
  p: PrSummary;
  filed: { lane: LaneId };
}

export function PrLaneSync({ lane, rows, me, readOnly, syncing, behindKnown, onSyncOne, onStep, onRetryReady }: {
  lane: { id: LaneId; label: string; tint: string };
  /** The whole board: the plan reads only this lane's rows. */
  rows: readonly LaneSyncRow[];
  /** The logged-in login. Empty means nothing is "mine" and the button says None. */
  me: string;
  readOnly?: boolean;
  /** Pull requests whose Update is already in flight, from the card's own set. */
  syncing?: ReadonlySet<number>;
  /** The last answer held, never a new ask: the header is not what puts a comparison in the queue. */
  behindKnown: (n: number) => number | null;
  /** The card's Update, on GitHub and only then on this computer. */
  onSyncOne: (p: PrSummary) => Promise<{ ok: boolean; detail?: string }>;
  /** Every transition of this press, for the cards underneath: queued, syncing, done, failed. */
  onStep?: (number: number, step: SyncCardStep | null) => void;
  /** The board holds this while the popover is mounted: a card's Retry runs through the press that owns its results. */
  onRetryReady?: (lane: LaneId, retry: ((n: number) => Promise<void>) | null) => void;
}) {
  const [open, setOpen] = useState(false);
  /* Kept across a retry: the successes of the first press are still successes,
     and the tally has to keep counting them. */
  const [results, setResults] = useState<SyncResult[] | null>(null);
  /** The numbers of the press running now, so "3 of 5" is this press and not every one ever tried. */
  const [run, setRun] = useState<readonly number[]>([]);
  const [running, setRunning] = useState(false);
  const [skipsOpen, setSkipsOpen] = useState(false);
  /** The rows a worker has picked up; the rest are waiting, and the list says so. */
  const [started, setStarted] = useState<ReadonlySet<number>>(() => new Set());
  /** The one card's Retry running now, so this list cannot send it a second time. */
  const [retrying, setRetrying] = useState<number | null>(null);
  /** The card Retries still behind that one: their cards say Waiting, so this list must too. */
  const [queued, setQueued] = useState<ReadonlySet<number>>(() => new Set());
  const retryLine = useRef(serialRetry());
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  /* Frozen when the run starts: the live plan would empty itself as each one
     is marked syncing, and the list has to stay legible while it runs. */
  const [frozen, setFrozen] = useState<ReturnType<typeof laneSyncPlan> | null>(null);
  const plan = frozen ?? laneSyncPlan(lane.id, rows, { viewer: me, readOnly, syncing, behindOf: behindKnown });

  const close = useCallback(() => {
    setOpen(false);
    setFrozen(null);
    btn.current?.focus({ preventScroll: true });
  }, []);
  // Hiding the bench closes this list with it: it is a portal, so nothing else would.
  useCloseWithOwner(() => setOpen(false), { open, from: btn });

  // Esc, and a click anywhere outside: the popover is not modal over the board.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? []);
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      // Trapped: Tab off either end wraps, so focus never leaves the list.
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    };
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", outside, true);
    const t = setTimeout(() => box.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true }), 0);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", outside, true); clearTimeout(t); };
  }, [open, close]);

  const start = async (items: readonly SyncItem[]) => {
    if (running || !items.length) return;
    setFrozen(plan);
    setRunning(true);
    /* A retried row starts over: its old failed answer would count it as done
       the moment the press began. */
    setResults((prev) => withoutResults(prev, items));
    setRun(items.map((i) => i.number));
    setStarted(new Set());
    /* Every card of the press goes quiet first: three start now, the rest wait,
       and a waiting card that still offered Update would be a second send. */
    for (const i of items) onStep?.(i.number, { phase: "queued" });
    await runLaneSync(items, async (n) => {
      const row = plan.eligible.find((i) => i.number === n)!;
      const p = rows.find((r) => r.p.number === n)!.p;
      const r = await onSyncOne({ ...p, title: row.title });
      return { ok: r.ok, detail: r.detail };
    }, (r) => {
      setResults((prev) => mergeResult(prev ?? [], r));
      onStep?.(r.number, { phase: r.status, detail: r.detail });
    }, (n) => {
      setStarted((cur) => new Set(cur).add(n));
      onStep?.(n, { phase: "syncing" });
    });
    setRunning(false);
  };

  /* The card's Retry: the row it already has, run by the same runner, its answer
     folded into this press's results so the list stops offering it again. It
     does not read the plan — a row GitHub just refused has left it. */
  const retryOne = useCallback(async (n: number) => {
    const row = rows.find((r) => r.p.number === n);
    const it = retryFromRow(row, behindKnown);
    if (!it || !row) { onStep?.(n, null); return; }
    const press = retryLine.current(n, async () => {
      setQueued((cur) => { if (!cur.has(n)) return cur; const next = new Set(cur); next.delete(n); return next; });
      setRetrying(n);
      try {
        setResults((prev) => withoutResults(prev, [it]));
        await runLaneSync([it], async () => {
          const r = await onSyncOne({ ...row.p, title: it.title });
          return { ok: r.ok, detail: r.detail };
        }, (r) => {
          setResults((prev) => mergeResult(prev ?? [], r));
          onStep?.(r.number, { phase: r.status, detail: r.detail });
        }, (x) => onStep?.(x, { phase: "syncing" }));
      } finally {
        setRetrying(null);
      }
    }, () => {
      setQueued((cur) => new Set(cur).add(n));
      onStep?.(n, { phase: "queued" });
    });
    /* null: that number is already waiting its turn or running, and its card says so. */
    await press;
  }, [rows, behindKnown, onSyncOne, onStep]);
  useEffect(() => {
    onRetryReady?.(lane.id, retryOne);
    return () => onRetryReady?.(lane.id, null);
  }, [lane.id, onRetryReady, retryOne]);

  const tally = results ? syncTally(results, plan.skipped.length) : null;
  const doneCount = run.filter((n) => results?.some((r) => r.number === n)).length;
  /* A retry re-plans from the numbers that failed: pressing it again must not
     send a second `gh pr update-branch` for a branch that already moved. */
  const again = tally && !tally.ok ? retryItems(plan, results ?? []) : plan.eligible;
  const label = running ? `${doneCount}/${run.length || plan.eligible.length}` : plan.eligible.length ? `Sync ${plan.eligible.length}` : "None";
  const reason = plan.eligible.length ? `Sync ${plan.eligible.length} pull requests in ${lane.label}` : nothingToDo(plan.skipped.map((s) => s.reason));

  return (
    <>
      <Button buttonRef={btn} size="hit" tint={lane.tint} disabled={!plan.eligible.length || running}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? listId : undefined}
        label={reason} title={reason}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        style={{ fontFamily: CODE_FONT_STYLE.fontFamily, fontSize: 10.5, fontWeight: 600, gap: 2, paddingInline: 6 }}>
        <RefreshIcon size={ICON.xs} />{label}
      </Button>
      {open && (
        <Portal z={LAYER.menu}>
          <div ref={box} id={listId} role="dialog" aria-label={`Sync ${lane.label}`}
            // A portal still bubbles React events to the header it came from, and a click there folds the lane.
            onClick={(e) => e.stopPropagation()}
            className="fixed flex flex-col overflow-hidden rounded-xl"
            style={{
              top: topOf(btn.current), left: leftOf(btn.current),
              width: SYNC_POP_WIDTH, maxHeight: "min(80vh, 74vh)",
              zIndex: 9999, background: "var(--surface-card)", border: EDGE,
              boxShadow: "var(--surface-lift), 0 18px 44px -14px var(--shadow)",
              "--lane": lane.tint,
            } as CSSProperties}>
            <div style={{ height: 3, background: lane.tint }} />
            <div className="shrink-0 px-3 pt-2.5 pb-2" style={{ borderBottom: EDGE }}>
              <div style={{ ...CODE_FONT_STYLE, fontSize: 9.5, letterSpacing: "0.07em", textTransform: "uppercase", color: lane.tint, fontWeight: 600 }}>{lane.label}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <h2 className="m-0 truncate" style={{ ...CODE_FONT_STYLE, fontSize: 14, fontWeight: 650, color: "var(--text)" }}>
                  {running ? `Syncing ${run.length || plan.eligible.length}` : tally && !tally.ok ? tally.text : `Sync ${plan.eligible.length} pull request${plan.eligible.length === 1 ? "" : "s"}`}
                </h2>
                <span className="ml-auto shrink-0" style={{ ...CODE_FONT_STYLE, fontSize: 9.5, color: "var(--text4)" }}>
                  {SYNC_AT_ONCE} at a time
                </span>
              </div>
              <p className="m-0 mt-1" style={{ ...CODE_FONT_STYLE, fontSize: 11, lineHeight: 1.45, color: "var(--text2)" }}>
                Merges the base into each branch on GitHub. A clean local copy follows; anything dirty, ahead, or mid-merge is left alone.
              </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
              {plan.eligible.map((it) => {
                /* A card's Retry is this list's row too: it shows the merge, not the
                   failed answer it is replacing. */
                const mine = retryRow(retrying, queued, it.number);
                const own = mine !== null;
                const r = own ? undefined : results?.find((x) => x.number === it.number);
                const live = running || own;
                const tone = r?.status === "done" ? "var(--success)" : r?.status === "failed" ? "var(--error)" : live ? lane.tint : "var(--text4)";
                return (
                  <div key={it.number} className="flex items-start gap-2 px-3 py-1.5" style={{ ...CODE_FONT_STYLE, fontSize: 11 }}>
                    <span className="grid place-items-center shrink-0" style={{ width: 18, height: 18, color: tone }}>
                      {r?.status === "done" ? <DoneIcon size={ICON.xs} /> : r?.status === "failed" ? <WarningIcon size={ICON.xs} /> : <RefreshIcon size={ICON.xs} />}
                    </span>
                    <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="flex items-baseline gap-1.5 min-w-0">
                        <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)", fontSize: 10.5 }}>#{it.number}</span>
                        <span className="truncate" style={{ color: "var(--text)", fontWeight: 600 }}>{it.title}</span>
                      </span>
                      <span className="flex items-center gap-1.5 min-w-0" style={{ fontSize: 9.5, color: r?.status === "failed" ? "var(--error)" : "var(--text3)" }}>
                        <span className="truncate">{r ? r.detail : live ? (mine === "merging" || started.has(it.number) ? "Merging the base into the branch…" : "Waiting") : `local copy updates where clean · ${it.title ? "" : ""}`}</span>
                        <span className="ml-auto shrink-0 tabular-nums px-1 py-0.5 rounded" style={{
                          color: r?.status === "done" ? "var(--success)" : r?.status === "failed" ? "var(--error)" : "var(--warning)",
                          background: `color-mix(in srgb, ${r?.status === "done" ? "var(--success)" : r?.status === "failed" ? "var(--error)" : "var(--warning)"} 8%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${r?.status === "done" ? "var(--success)" : r?.status === "failed" ? "var(--error)" : "var(--warning)"} 22%, transparent)`,
                        }}>{r?.status === "done" ? "updated" : r?.status === "failed" ? "failed" : `${it.behind} behind`}</span>
                      </span>
                    </span>
                  </div>
                );
              })}

              {plan.skipped.length > 0 && (
                <div style={{ borderTop: EDGE }}>
                  <button type="button" onClick={() => setSkipsOpen((v) => !v)} aria-expanded={skipsOpen}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 agx-hover"
                    style={{ ...CODE_FONT_STYLE, fontSize: 10.5, fontWeight: 600, color: "var(--text2)", background: "var(--surface-inset)", border: 0, cursor: "pointer" }}>
                    <span className="shrink-0 whitespace-nowrap">{plan.skipped.length} left alone</span>
                    <span className="ml-auto truncate min-w-0" style={{ fontWeight: 400, color: "var(--text4)" }}>{[...new Set(plan.skipped.map((s) => SYNC_REASON[s.reason]))].join(" · ")}</span>
                  </button>
                  {skipsOpen && plan.skipped.map((s) => (
                    <div key={s.number} className="flex items-center gap-2 px-3 py-1" style={{ ...CODE_FONT_STYLE, fontSize: 10.5 }}>
                      <span className="shrink-0 tabular-nums" style={{ width: 34, color: "var(--text3)" }}>#{s.number}</span>
                      <span className="truncate min-w-0 flex-1" style={{ color: "var(--text2)" }}>{s.title}</span>
                      <span className="shrink-0 rounded px-1 py-0.5" style={{ fontSize: 9, fontWeight: 600, color: s.reason === "conflict" ? "var(--error)" : "var(--text3)", background: "var(--surface-inset)" }}>{SYNC_REASON[s.reason]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-2 px-3 py-2" style={{ borderTop: EDGE, background: "var(--surface-inset)", ...CODE_FONT_STYLE, fontSize: 10 }}>
              {running ? (
                <>
                  <RefreshIcon size={ICON.xs} />
                  <span className="tabular-nums">{doneCount} of {run.length || plan.eligible.length}</span>
                  <span className="flex-1 min-w-8 h-1 rounded overflow-hidden" style={{ background: `color-mix(in srgb, ${lane.tint} 18%, transparent)` }}>
                    <span className="block h-full rounded" style={{ width: `${(doneCount / Math.max(1, run.length || plan.eligible.length)) * 100}%`, background: lane.tint }} />
                  </span>
                </>
              ) : tally ? (
                <>
                  {tally.ok ? <DoneIcon size={ICON.xs} /> : <WarningIcon size={ICON.xs} />}
                  <span className="truncate" style={{ color: tally.ok ? "var(--success)" : "var(--error)" }}>{tally.text}</span>
                </>
              ) : (
                <span style={{ color: "var(--text3)" }}>Only this lane · only your pull requests</span>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-2 px-3 py-2" style={{ borderTop: EDGE }}>
              <Button size="hit" onClick={close}>Close</Button>
              <span className="flex-1" />
              <Button size="hit" tone="primary" onClick={() => void start(again)} disabled={confirmOff({ running, retrying, queued: queued.size, items: again, ok: !!tally?.ok })}
                pending={running}>
                {confirmLabel(tally, again, plan.eligible.length)}
              </Button>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

const nothingToDo = (reasons: string[]): string => {
  const n: Record<string, number> = {};
  for (const r of reasons) n[r] = (n[r] ?? 0) + 1;
  const bits = Object.entries(n).map(([r, c]) => `${c} ${r}`);
  return bits.length ? `Nothing to sync here: ${bits.join(" · ")}` : "Nothing to sync here";
};

/** Under the button, flipped above it when the window has no room below. */
function topOf(el: HTMLElement | null): number {
  if (!el) return 0;
  const a = el.getBoundingClientRect();
  return Math.max(8, Math.min(a.bottom + 6, window.innerHeight - 320));
}
function leftOf(el: HTMLElement | null): number {
  if (!el) return 0;
  const a = el.getBoundingClientRect();
  return Math.max(8, Math.min(a.left - 8, window.innerWidth - SYNC_POP_WIDTH - 8));
}
