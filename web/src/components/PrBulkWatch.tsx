/*
 * The PR board's selection bar: "3 selected · Tell me when… · Clear Esc", floating over the bottom of the board,
 * and the bulk "Tell me when…" that opens up from it.
 *
 * The single-PR popover (PrWatchMenu.tsx) writes on every press. For N pull requests one explicit Apply is the
 * honest shape: one request (POST /prs/notify-watch/set-many), one toast, one Undo. Apply leaves every picked PR
 * with exactly the cards that are on; a card only some of them have is drawn "mixed" until pressed, and applying
 * replaces their choice (the popover says so). The decisions live in lib/prBulkPick.ts.
 *
 * The bar's second action, "Request review…", is PrBulkAsk.tsx; only one of the two popovers is open at a time.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import type { PrSummary, PrWatchSetItem } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { CommentIcon, DoneIcon, MergeIcon, UndoIcon, WarningIcon, CrossIcon } from "../lib/glyphIcons.tsx";
import { HIT, ICON } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import {
  applyItems, canApply, undoItems, undoSkippedLine, cardRulesOf, cardState, CARD_RULES, footLine, haveCount, RULE_SHORT, RULE_WORDS, startChosen, toastLine, watchedCount, type CardRule,
} from "../lib/prBulkPick.ts";
import { reloadPrWatches, usePrWatchState, watchesOf } from "../lib/prWatchStore.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { WatchCard } from "./PrWatchMenu.tsx";
import { PrBulkAsk } from "./PrBulkAsk.tsx";
import { BellIcon } from "./settingsNavIcons.tsx";
import { Button } from "./workspace/Chrome.tsx";

/** How long the toast and its Undo stay. */
export const BULK_TOAST_MS = 6_000;

const HUE: Record<CardRule, string> = { "ci-pass": "var(--success)", "ci-fail": "var(--error)", comment: "var(--info)" };
const EX: Record<CardRule, string> = {
  "ci-pass": "Once every check on each one has passed. One note per pull request.",
  "ci-fail": "The first failure on each one, then that one turns itself off.",
  comment: "Every new comment or review on any of them, until I turn it off.",
};

export function PrBulkWatch({ root, repo, picked, left, onClear, onKeep }: {
  root: string; repo: string;
  /** The picked pull requests, in board order. Empty draws no bar (the toast may still be up). */
  picked: readonly PrSummary[];
  /** "#1051 merged, left": said once when a picked one leaves the board. */
  left: string | null;
  onClear: () => void;
  /** After a partly failed Apply: the selection becomes just these, so the failed ones can be tried again. */
  onKeep: (numbers: readonly number[]) => void;
}): ReactElement | null {
  const state = usePrWatchState();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [chosen, setChosen] = useState<Set<CardRule>>(new Set());
  const [touched, setTouched] = useState<Set<CardRule>>(new Set());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; root: string; prev: PrWatchSetItem[]; set: PrWatchSetItem[]; at: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, box, () => setOpen(false));

  const have = useMemo(() => picked.map((p) => cardRulesOf(watchesOf(state, repo, p.number))), [picked, state, repo]);
  const watched = watchedCount(have);
  const n = picked.length;
  useEffect(() => { if (!n) setOpen(false); }, [n]);
  /* Focus goes into the popover on open (its first card) and back to "Tell me when…" on close, unless the close was a
     click that put focus somewhere else on purpose. Tab is kept inside while it is open (trapTab). */
  const pop = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLElement>(".pw-cards button")?.focus();
    else if (wasOpen.current) {
      const a = document.activeElement;
      if (!a || a === document.body || box.current?.contains(a)) box.current?.querySelector<HTMLElement>("[data-bulk-watch]")?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !pop.current) return;
    const all = [...pop.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
    if (!all.length) return;
    const first = all[0]!, last = all[all.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), BULK_TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleOpen = () => {
    if (!open) { setChosen(startChosen(have)); setTouched(new Set()); setErr(""); setAsking(false); }
    setOpen((v) => !v);
  };
  const press = (r: CardRule) => {
    const on = cardState(r, chosen, touched, have) !== "true";
    setChosen((c) => { const x = new Set(c); if (on) x.add(r); else x.delete(r); return x; });
    setTouched((t) => new Set(t).add(r));
  };
  const apply = async () => {
    setBusy(true);
    const set = applyItems(picked, chosen);
    const r = await api.prWatchSetMany(root, set).catch(() => ({ ok: false, prev: [] as PrWatchSetItem[], failed: [] as number[], error: "could not save that" }));
    setBusy(false);
    reloadPrWatches();
    if (!r.ok && !r.prev.length) { setErr(r.error ?? "could not save that"); return; }
    setOpen(false);
    setToast({ text: r.ok ? toastLine(n, chosen) : `${toastLine(n, chosen)} · ${r.error}`, root, prev: r.prev, set, at: Date.now() });
    if (r.failed?.length) onKeep(r.failed); else onClear();
  };
  const undo = async () => {
    if (!toast) return;
    /* The root Apply wrote to, never the board's current one: the server reads the repository from it, and the board
       may have moved to another repository within the toast's 6 s. */
    const was = toast;
    setToast(null);
    if (!was.prev.length) return;
    const r = await api.prWatchSetMany(was.root, undoItems(was.prev, was.set)).catch(() => ({ ok: false, prev: [] as PrWatchSetItem[], skipped: [] as number[], error: "could not reach the app" }));
    reloadPrWatches();
    /* A refused Undo comes back with its Undo, so it can be tried again: the toast had already gone, and the user
       would otherwise think it was undone. */
    if (!r.ok) setToast({ ...was, text: `Could not undo: ${r.error ?? "could not save that"}`, at: Date.now() });
    else if (r.skipped?.length) setToast({ ...was, text: undoSkippedLine(r.skipped), prev: [], at: Date.now() });
  };

  /* The "Now" lines, over all of them: the same live words the single popover has, summed. */
  const sum = picked.reduce((a, p) => ({ pass: a.pass + p.checks.success, run: a.run + p.checks.pending, fail: a.fail + p.checks.failure, total: a.total + p.checks.total }), { pass: 0, run: 0, fail: 0, total: 0 });
  const allGreen = picked.filter((p) => p.checks.total > 0 && p.checks.allDone && p.checks.verdict === "green").length;
  const failing = picked.filter((p) => p.checks.failure > 0).length;
  const pc = (x: number) => `${sum.total ? (x / sum.total) * 100 : 0}%`;
  const mixWord = (r: CardRule) => cardState(r, chosen, touched, have) === "mixed"
    ? <span style={{ color: "var(--text3)" }}> · {haveCount(r, have)} of {n} have it</span> : null;
  const NOW: Record<CardRule, ReactElement> = {
    "ci-pass": <>
      <span className="pw-meter" aria-hidden="true"><i style={{ width: pc(sum.pass), background: "var(--success)" }} /><i style={{ width: pc(sum.run), background: "var(--warning)" }} /><i style={{ width: pc(sum.fail), background: "var(--error)" }} /></span>
      <span>{allGreen}/{n} all green · {sum.run} running{mixWord("ci-pass")}</span>
    </>,
    "ci-fail": <span>{failing ? <><b style={{ color: "var(--error-ink)", fontWeight: 500 }}>{failing} already failing</b> · you'd hear the next</> : "nothing has failed yet"}{mixWord("ci-fail")}</span>,
    comment: <span>{haveCount("comment", have)} of {n} watch comments now{mixWord("comment")}</span>,
  };
  const ICONS: Record<CardRule, ReactElement> = { "ci-pass": <DoneIcon size={ICON.md} />, "ci-fail": <WarningIcon size={ICON.md} />, comment: <CommentIcon size={ICON.md} /> };

  const bar = n > 0 && (
    <div className="agx-bulk-bar" role="toolbar" aria-label={`${n} selected`} data-bulk-toolbar style={{ zIndex: LAYER.board }}>
      <span className="agx-bulk-n">{n} selected</span>
      {left && <span className="agx-bulk-note" role="status"><MergeIcon size={ICON.xs} /><span>{left}</span></span>}
      <span className="agx-bulk-sep" aria-hidden />
      <span className="relative flex" ref={box}>
        <Button size="hit" tone={open ? "primary" : "plain"} aria-haspopup="true" aria-expanded={open} onClick={toggleOpen} data-bulk-watch>
          <BellIcon size={ICON.sm} />Tell me when…
        </Button>
        {open && (
          <div ref={pop} onKeyDown={trapTab} className="pw-pop" data-bulk role="group" aria-label={`Notify me about ${n} pull requests`} style={{ maxHeight: "min(560px, calc(100vh - 140px))" }}>
            <div className="pw-body">
              <div className="pw-q">Tell me when…<small>{n} pull request{n === 1 ? "" : "s"}</small></div>
              {watched > 0 && <div className="pw-mix"><BellIcon size={ICON.xs} />{watched} already watched · applying replaces their choice</div>}
              <div className="pw-cards">
                {CARD_RULES.map((r) => {
                  const s = cardState(r, chosen, touched, have);
                  return <WatchCard key={r} type={r} checked={s === "mixed" ? "mixed" : s === "true"} hue={HUE[r]} icon={ICONS[r]} tt={RULE_WORDS[r]} ex={EX[r]} now={NOW[r]} onClick={() => press(r)} />;
                })}
              </div>
              <div className="pw-run">
                <div className="pw-runh"><b>These {n}</b><span className="pw-meta">{sum.total} checks · {sum.pass} green · {sum.run} running · {sum.fail} failed</span></div>
                <div className="pw-list" role="list">
                  {picked.map((p, i) => (
                    <div key={p.number} className="pw-row" role="listitem">
                      <span className="pw-num">#{p.number}</span><span className="pw-tt">{p.title}</span>
                      {have[i]!.length ? <span className="pw-was" aria-label={`Watching now: ${have[i]!.map((r) => RULE_WORDS[r]).join(", ")}`}><BellIcon size={ICON.xs} />{have[i]!.map((r) => RULE_SHORT[r]).join(", ")}</span> : <span />}
                      <span className="pw-ck">{p.checks.failure ? <span style={{ color: "var(--error-ink)" }}>{p.checks.failure} failed</span> : `${p.checks.success}/${p.checks.total}`}</span>
                    </div>
                  ))}
                </div>
              </div>
              {err && <div className="pw-meta" style={{ marginTop: 8, color: "var(--error-ink)" }}>{err}</div>}
            </div>
            <div className="pw-foot">
              <span>{footLine(chosen, n, watched)}</span>
              <Button size="hit" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="hit" tone="primary" disabled={!canApply(chosen, watched) || busy} pending={busy} onClick={() => void apply()} data-bulk-apply>Apply to {n}</Button>
            </div>
          </div>
        )}
      </span>
      <PrBulkAsk root={root} repo={repo} picked={picked} open={asking} onOpen={(v) => { setAsking(v); if (v) setOpen(false); }} onDone={onClear} />
      <Button size="hit" onClick={onClear}>Clear <span className="agx-bulk-kbd">Esc</span></Button>
    </div>
  );

  return (
    <>
      {bar || null}
      {toast && (
        <div className="agx-bulk-toast" role="status" data-bulk-toast style={{ zIndex: LAYER.board, "--life": `${BULK_TOAST_MS}ms` } as CSSProperties} key={toast.at}>
          <BellIcon size={ICON.md} />
          <span className="agx-bulk-msg">{toast.text}</span>
          {toast.prev.length > 0 && <Button size="hit" onClick={() => void undo()} data-bulk-undo><UndoIcon size={ICON.xs} />Undo</Button>}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className="grid place-items-center rounded-lg agx-hover shrink-0"
            style={{ width: HIT, height: HIT, color: "var(--text4)" }}><CrossIcon size={ICON.xs} /></button>
          <i className="agx-bulk-life" aria-hidden />
        </div>
      )}
    </>
  );
}
