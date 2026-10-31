// The Source control header: where you are (checkout, tabs, branch), what is
// going on around it (the situational slot), and the remote controls. The
// decisions live in lib/gitHeader.ts and lib/gitHeaderErrors.ts; this file is
// the drawing and the three network actions.
//
// A failed fetch, pull or push is a card anchored to its own button, not the
// toast. The toast vanished in 2.6 s and held one sentence; what failed, on
// which remote, and what to press next needs to stay until it is read. The
// command log still records the full text.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GitBranchInfo, GitLastFetch } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { BranchIcon, ChartIcon, CommitIcon, DoneIcon, MoreIcon, PlusIcon, RefreshIcon, TerminalIcon, WarningIcon, FolderIcon } from "../lib/glyphIcons.tsx";
import {
  badgeNotes, chipView, disabledReason, fetchEach, fetchedLabel, headerFacts, headerShape, nextSqueeze, slotItems, splitSlot, stateBanner, upstreamRemote,
  type SlotId,
} from "../lib/gitHeader.ts";
import { failedRemotes, fetchCard, pullCard, pushCard, type FailCard } from "../lib/gitHeaderErrors.ts";
import { AnchoredMenu } from "./AnchoredMenu.tsx";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import { EDGE } from "./workspace/Chrome.tsx";

/** What the panel hands over for one situational item: the node it draws in the
 *  slot, and the label and press it has once it is behind "+N". */
export interface SlotEntry { label: string; /** Absent: the item is information only, and behind "+N" it is shown but cannot be pressed. */ run?: () => void; node: ReactNode }
export type SlotEntries = Partial<Record<"pr" | "prs-land" | "pr-unknown" | "sync" | "undo" | "bisect", SlotEntry>>;

// One size for every control in the row: 26 high, 7 round.
const CTL = "inline-flex items-center gap-1.5 h-[26px] px-2.5 text-[11px] whitespace-nowrap shrink-0 font-medium transition-colors active:scale-[0.97]";
const ctl = (tone: "plain" | "dark" | "err" | "warn" | "dashed" = "plain", off = false): CSSProperties => ({
  borderRadius: 7,
  opacity: off ? 0.45 : 1,
  ...(tone === "dark" ? { background: "var(--text)", color: "var(--bg)", border: "1px solid var(--text)" }
    : tone === "err" ? { background: "color-mix(in srgb, var(--text) 4%, transparent)", color: "var(--error-ink)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }
    : tone === "warn" ? { color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }
    : tone === "dashed" ? { color: "var(--text4)", border: "1px dashed color-mix(in srgb, var(--text) 25%, transparent)" }
    : { background: "color-mix(in srgb, var(--text) 4%, transparent)", color: "var(--text2)", border: EDGE }),
});

/** The strip under the header while git is stopped mid-merge, mid-rebase…
 *  It is drawn by the panel in the conflict screen too, which replaces the
 *  header: a stopped repo must say so, and keep its way out, on every screen. */
export function StateBanner({ state, conflicts, busy, onAbort, onContinue }: {
  state: string | undefined; conflicts: number | null; busy: boolean; onAbort: () => void; onContinue: () => void;
}) {
  const b = stateBanner(state, conflicts);
  if (!b) return null;
  return (
    <div data-state-banner={state} className="shrink-0 px-4 py-2 border-b flex items-center gap-2 flex-wrap"
      style={{ borderColor: "color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: "var(--warning-ink)" }}>{b.text}</span>
      {/* Abort first, and always available: the one move that is safe from any stopped state. */}
      <button data-banner-abort onClick={onAbort} disabled={busy} className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
        style={{ color: "var(--error-ink)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}
        title="Throw it away and put the tree back exactly as it was">abort</button>
      {b.canContinue && (
        <button data-banner-continue onClick={onContinue} disabled={busy || !!b.continueWhy} className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
          style={{ color: "var(--success-ink)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: b.continueWhy ? 0.4 : 1 }}
          title={b.continueWhy ?? "commit the merge"}>continue</button>
      )}
    </div>
  );
}

const Spin = () => <span className="animate-spin inline-flex"><RefreshIcon size={ICON.xs} /></span>;

export function GitHeader({
  root, branch, stateLabel, writeEnabled, busy, treeStale, picker, tabs, slot, refresh,
  onBusy, onChanged, flash, onCopied, onOpenInsights, onOpenRemotes, onOpenLog, onMakeBranch,
}: {
  root: string;
  branch: GitBranchInfo | undefined;
  stateLabel: (state: string) => string | null;
  writeEnabled: boolean;
  /** Some git action is running, from this header or anywhere in the panel. */
  busy: boolean;
  treeStale: boolean;
  picker: ReactNode;
  tabs: ReactNode;
  slot: SlotEntries;
  refresh: ReactNode;
  onBusy: (b: boolean) => void;
  /** Reload what an action moved: the working tree and the repo list. */
  onChanged: () => Promise<void>;
  flash: (ok: boolean, msg: string) => void;
  onCopied: (name: string) => void;
  onOpenInsights: () => void;
  onOpenRemotes: () => void;
  onOpenLog: () => void;
  /** Name a branch at the commit HEAD is on. */
  onMakeBranch: () => void;
}) {
  const [remotes, setRemotes] = useState<string[] | null>(null);
  const [last, setLast] = useState<GitLastFetch | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [running, setRunning] = useState<"fetch" | "pull" | "push" | null>(null);
  const [steps, setSteps] = useState<{ remote: string; state: "wait" | "run" | "ok" | "fail" }[]>([]);
  const [card, setCard] = useState<FailCard | null>(null);
  const [failed, setFailed] = useState<"fetch" | "pull" | "push" | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const fetchAnchor = useRef<HTMLSpanElement>(null);
  const pullAnchor = useRef<HTMLSpanElement>(null);
  const pushAnchor = useRef<HTMLSpanElement>(null);
  const moreAnchor = useRef<HTMLSpanElement>(null);

  const loadLast = () => { api.gitLastFetch(root).then(setLast).catch(() => setLast(null)); };
  // A different checkout or branch is a different question; yesterday's
  // failure on the other one is not this one's.
  useEffect(() => { setCard(null); setFailed(null); setLast(null); }, [root, branch?.name]);
  useEffect(() => {
    let live = true;
    api.gitRemotes(root).then((r) => { if (live) setRemotes(r.remotes.map((x) => x.name)); }).catch(() => { if (live) setRemotes(null); });
    return () => { live = false; };
  }, [root, branch?.name, branch?.upstream]);
  useEffect(() => {
    if (!branch?.detached) { setSha(null); return; }
    let live = true;
    api.gitWorktrees(root).then((r) => { if (live) setSha(r.worktrees.find((w) => w.path === root)?.head?.slice(0, 7) || null); }).catch(() => {});
    return () => { live = false; };
  }, [root, branch?.detached, branch?.name]);

  // Unknown remotes count as "has one": drawing "no remote" on a guess would
  // flash the door for a repository that has three.
  const hasRemote = remotes === null ? true : remotes.length > 0;
  const facts = headerFacts(branch, {
    hasRemote, hasPr: !!slot.pr, prsLand: !!slot["prs-land"], prUnknown: !!slot["pr-unknown"],
    canSync: !!slot.sync, canUndo: !!slot.undo,
  });
  const reasons = { fetch: disabledReason("fetch", facts), pull: disabledReason("pull", facts), push: disabledReason("push", facts) };
  const off = (op: "fetch" | "pull" | "push") => !writeEnabled || busy || !!reasons[op];

  const fail = (c: FailCard) => { setCard(c); setFailed(c.op); };
  const finish = async () => { await onChanged(); loadLast(); };
  const begin = (op: "fetch" | "pull" | "push") => { if (busy) return false; onBusy(true); setRunning(op); setCard(null); setFailed(null); return true; };
  const end = () => { onBusy(false); setRunning(null); setSteps([]); };

  /** One request per remote, in order, each result shown as it lands. */
  const doFetch = async (only?: string[]) => {
    const names = only?.length ? only : (remotes ?? []);
    if (!begin("fetch")) return;
    try {
      // Every remote is listed from the start, so a slow first one is not a card with nothing in it.
      setSteps(names.length > 1 ? names.map((remote) => ({ remote, state: "wait" as const })) : []);
      const results = await fetchEach(names, (r) => api.gitFetch(root, r), (remote, state) =>
        setSteps((cur) => cur.some((s) => s.remote === remote) ? cur.map((s) => s.remote === remote ? { remote, state } : s) : [...cur, { remote, state }]));
      const c = fetchCard(results);
      await finish();
      if (c) fail(c); else flash(true, "fetched");
    } finally { end(); }
  };
  const doPull = async (thenPush = false) => {
    if (!begin(thenPush ? "push" : "pull")) return;
    try {
      let r = await api.gitPull(root).catch((e) => ({ ok: false, error: String(e) }));
      if (!r.ok) { await finish(); fail(pullCard(r.error ?? "", { branch: branch?.name ?? "", upstream: branch?.upstream ?? null })); return; }
      if (!thenPush) { await finish(); flash(true, "pulled"); return; }
      r = await api.gitPush(root).catch((e) => ({ ok: false, error: String(e) }));
      await finish();
      if (r.ok) flash(true, "pulled and pushed");
      else fail(pushCard(r.error ?? "", { branch: branch?.name ?? "", ahead: branch?.ahead ?? 0, behind: 0, remote: upstreamRemote(branch?.upstream) ?? "origin" }));
    } finally { end(); }
  };
  const doPush = async () => {
    if (!begin("push")) return;
    try {
      const r = await api.gitPush(root).catch((e) => ({ ok: false, error: String(e) }));
      await finish();
      if (r.ok) flash(true, "pushed");
      else fail(pushCard(r.error ?? "", { branch: branch?.name ?? "", ahead: branch?.ahead ?? 0, behind: branch?.behind ?? 0, remote: upstreamRemote(branch?.upstream) ?? "origin" }));
    } finally { end(); }
  };

  // Closing the card also clears the red on its button: nothing is left to read.
  const closeCard = () => { setCard(null); setFailed(null); };
  const next = () => {
    const c = card; if (!c) return;
    closeCard();
    if (c.next.id === "open-remotes") onOpenRemotes();
    else if (c.next.id === "pull-then-push") void doPull(true);
    else if (c.next.id === "retry") {
      if (c.op === "fetch") void doFetch(failedRemotes(c));
      else if (c.op === "pull") void doPull();
      else void doPush();
    }
  };

  // The slot: the way out of a dead end leads, then whatever the branch is in.
  const entries: Partial<Record<SlotId, SlotEntry>> = {
    ...slot,
    "add-remote": { label: "Add a remote…", run: onOpenRemotes, node: (
      <button data-control="add-remote" onClick={onOpenRemotes} className={CTL} style={ctl()}
        title="Open the Remotes tab, where a remote is added"><PlusIcon size={ICON.xs} />Add a remote…</button>) },
    "make-branch": { label: "Make a branch here", run: onMakeBranch, node: (
      <button data-control="make-branch" onClick={onMakeBranch} disabled={!writeEnabled || busy} className={CTL} style={ctl("plain", !writeEnabled || busy)}
        title="Not on a branch. New commits here belong to no branch until you name one."><PlusIcon size={ICON.xs} />Make a branch here</button>) },
  };
  // Give up one thing at a time while the row is wider than the window; see headerShape.
  const [squeeze, setSqueeze] = useState(0);
  const shape = headerShape(squeeze);
  const { visible, overflow } = splitSlot(slotItems(facts).filter((id) => entries[id]), shape.slotMax, "sync");

  const chip = branch ? chipView(branch, hasRemote, sha, stateLabel) : null;
  const notes = badgeNotes(facts);
  const root$ = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pickerW, setPickerW] = useState(0);
  useLayoutEffect(() => {
    const el = root$.current; if (!el || typeof ResizeObserver === "undefined") return;
    // The picker is the first thing after the sr-only title; it is the one
    // child whose width does not change when the row squeezes.
    const pick = el.children[1] as HTMLElement | undefined;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); if (pick) setPickerW(pick.offsetWidth); });
    ro.observe(el);
    if (pick) ro.observe(pick);
    return () => ro.disconnect();
  }, []);
  // A different window width or a different set of things to show starts again
  // from everything; the effect below then steps down before the next paint.
  // Anything that changes what a button says (the running label, the publish
  // target, the picker's width) is a reason to try the wider shape again.
  const pushLabel = !facts.hasUpstream && facts.hasRemote && !facts.detached ? `publish to ${upstreamRemote(branch?.upstream) ?? remotes?.[0] ?? "origin"}` : "push";
  const fitKey = `${width}|${pickerW}|${visible.length + overflow.length}|${hasRemote}|${facts.hasUpstream}|${chip?.text}|${chip?.state}|${facts.ahead}|${facts.behind}|${running}|${pushLabel}|${treeStale}`;
  const lastKey = useRef(fitKey);
  useLayoutEffect(() => {
    const el = root$.current; if (!el) return;
    const justReset = lastKey.current !== fitKey;
    lastKey.current = fitKey;
    const next = nextSqueeze(el.scrollWidth > el.clientWidth + 1, squeeze, justReset);
    if (next !== squeeze) setSqueeze(next);
  }, [squeeze, fitKey]);
  const fetched = fetchedLabel(last, Date.now());
  const fetchTitle = reasons.fetch ?? (fetched ? `${fetched.title}${fetched.sub ? `\n${fetched.sub}` : ""}` : "Fetch every remote, one after another");

  // The strip scrolls rather than shoves; it fades at the right edge only while
  // something is hidden there.
  const strip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = strip.current; if (!el) return;
    const measure = () => setClipped(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, []);

  const fade = "linear-gradient(90deg, #000 88%, transparent)";
  const running1 = (op: "fetch" | "pull" | "push") => running === op;

  return (
    // No overflow-hidden here, ever: the checkout picker's dropdown is
    // absolutely positioned inside this row, and clipping the row clipped the
    // menu to a sliver. Overflow is prevented by the tab strip scrolling and
    // the slot being capped, not by cutting off whatever escapes.
    <div ref={root$} className={viewHeaderClass} style={viewHeaderStyle}>
      <h2 className="sr-only">Source control</h2>
      {picker}
      <div ref={strip} className="flex items-center gap-2.5 ml-1 min-w-[96px] flex-1 overflow-x-auto agw-noscrollbar"
        style={clipped ? { WebkitMaskImage: fade, maskImage: fade } : undefined} data-tabs-strip>
        {tabs}
      </div>
      <div className="ml-auto flex items-center gap-1.5 shrink-0" style={{ opacity: treeStale ? 0.5 : 1, transition: "opacity .18s ease" }}>
        {/* Switched worktrees — say the numbers are being recomputed rather than
            leave the old branch's sync count sitting there looking current. */}
        {treeStale && <span className="animate-spin shrink-0 text-[12px]" style={{ color: "var(--text3)" }} title="Reading the branch you switched to…"><RefreshIcon size={ICON.xs} /></span>}
        {/* Never wider than 40% of the header, and never more than two items:
            the six controls to its right do not move for any state. */}
        {visible.length + overflow.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0 overflow-hidden" style={{ maxWidth: "40%" }} data-slot>
            {visible.map((id) => <span key={id} className="flex items-center shrink-0" data-slot-item={id}>{entries[id]!.node}</span>)}
            {overflow.length > 0 && (
              <span ref={moreAnchor} className="shrink-0">
                <button data-control="slot-more" onClick={() => setMoreOpen((o) => !o)} aria-haspopup="menu" aria-expanded={moreOpen}
                  className={CTL} style={ctl()} title={overflow.map((id) => entries[id]!.label).join("\n")}>
                  <MoreIcon size={ICON.xs} />+{overflow.length}
                </button>
              </span>
            )}
          </div>
        )}
        {moreOpen && (
          <AnchoredMenu anchor={moreAnchor} onClose={() => setMoreOpen(false)}>
            {overflow.map((id) => (
              <button key={id} role="menuitem" data-overflow-item={id} disabled={!entries[id]!.run} onClick={() => { setMoreOpen(false); entries[id]!.run?.(); }}
                className="text-left text-[11.5px] px-2.5 h-[28px] rounded-lg whitespace-nowrap hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]"
                style={{ color: "var(--text2)" }}>{entries[id]!.label}</button>
            ))}
          </AnchoredMenu>
        )}
        <button data-control="insights" onClick={onOpenInsights} disabled={busy} aria-label="Insights" title="Insights"
          className={`${CTL} !px-0 w-[26px] justify-center`} style={ctl("plain", busy)}><ChartIcon size={ICON.xs} /></button>
        {chip && (
          // One line, always. A ticket-shaped branch name is 60 characters and
          // used to wrap inside the chip, which made the whole header two rows
          // tall. The name truncates, the counts never do, and the full name is
          // one hover or one click away.
          <>
            <button data-control="chip" className={`${CTL} min-w-0 max-w-[min(30vw,340px)] !gap-1`}
              style={{ ...ctl("plain"), ...(chip.detached ? { color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" } : { color: "var(--text)" }), fontFamily: "var(--font-mono, inherit)" }}
              onClick={() => { if (!chip.detached && branch) navigator.clipboard?.writeText(branch.name).then(() => onCopied(branch.name)).catch(() => { /* no clipboard permission */ }); }}
              title={(chip.detached ? `Not on a branch: checked out at ${sha ?? "a commit"}.\nNew commits here belong to no branch.` : `${branch!.name}${branch!.upstream ? `\ntracking ${branch!.upstream}` : "\nno upstream, nothing to compare against"}\n\nclick to copy the branch name`)
                // What the squeezed row no longer draws is still said here.
                + (shape.badges ? "" : notes.map((n) => `\n${n.text}`).join("")) + (chip.state && !shape.chipState ? `\n${chip.state}` : "")}>
              {chip.detached ? <CommitIcon size={ICON.xs} /> : <BranchIcon size={ICON.xs} />}
              <span className="truncate min-w-0">{chip.text}</span>
              {chip.state && shape.chipState && <span style={{ color: "var(--warning-ink)" }}>({chip.state})</span>}
              {/* Behind first, then ahead: it reads "pull this many, push that many". */}
              {chip.sync && chip.sync.behind > 0 && <span style={{ color: "var(--warning-ink)" }}>↓{chip.sync.behind}</span>}
              {chip.sync && chip.sync.ahead > 0 && <span style={{ color: "var(--success-ink)" }}>↑{chip.sync.ahead}</span>}
              {chip.sync?.inSync && <span className="flex" style={{ color: "var(--success-ink)" }} title="in sync with upstream"><DoneIcon size={ICON.xs} /></span>}
            </button>
            {shape.badges && notes.map((n) => <span key={n.label} className={CTL} style={ctl("dashed")} title={n.text}>{n.label}</span>)}
          </>
        )}
        {/* Each says what it is doing while it does it, and why it is off when it is. */}
        <span ref={fetchAnchor} className="shrink-0" onMouseEnter={loadLast}>
          <button data-control="fetch" onClick={() => void doFetch()} disabled={off("fetch")} title={fetchTitle}
            className={CTL} style={ctl(failed === "fetch" ? "err" : "plain", off("fetch") && !running1("fetch"))}>
            {running1("fetch") ? <><Spin />fetching…</> : failed === "fetch" ? <><span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} />fetch</> : <><RefreshIcon size={ICON.xs} />fetch</>}
          </button>
        </span>
        <span ref={pullAnchor} className="shrink-0">
          <button data-control="pull" onClick={() => void doPull()} disabled={off("pull")} title={reasons.pull ?? "Bring the upstream's new commits down"}
            className={CTL} style={ctl(failed === "pull" ? "err" : "plain", off("pull") && !running1("pull"))}>
            {running1("pull") ? <><Spin />pulling…</> : <>{failed === "pull" && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} />}↓ pull{facts.behind > 0 && <span style={{ color: "var(--text3)" }}>{facts.behind}</span>}</>}
          </button>
        </span>
        <span ref={pushAnchor} className="shrink-0">
          <button data-control="push" onClick={() => void doPush()} disabled={off("push")} title={reasons.push ?? (facts.hasUpstream ? "Send your commits up" : `Send ${branch?.name ?? "this branch"} to its remote`)}
            className={CTL} style={ctl(failed === "push" ? "err" : facts.ahead > 0 || (!facts.hasUpstream && !off("push")) ? "dark" : "plain", off("push") && !running1("push"))}>
            {running1("push") ? <><Spin />pushing…</> : <>{failed === "push" && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} />}↑ <span className="truncate max-w-[22ch]">{pushLabel}</span>{facts.ahead > 0 && <span style={{ opacity: 0.7 }}>{facts.ahead}</span>}</>}
          </button>
        </span>
        <span className="w-px h-4 shrink-0" style={{ background: "color-mix(in srgb, var(--text) 14%, transparent)" }} aria-hidden />
        <span data-control="refresh" className="shrink-0 flex">{refresh}</span>
      </div>

      {/* While a fetch walks several remotes, each shows as it lands. */}
      {running === "fetch" && steps.length > 1 && (
        <AnchoredMenu anchor={fetchAnchor} onClose={() => { /* closing it does not stop the fetch */ }}>
          <div className="px-2 py-1.5 flex flex-col gap-1 min-w-[260px]" data-fetch-progress>
            {steps.map((s) => (
              <div key={s.remote} className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)", fontFamily: "var(--font-mono, inherit)" }}>
                <span className="w-4 flex justify-center">{s.state === "run" ? <Spin /> : <span className="w-2 h-2 rounded-full" style={{ background: s.state === "ok" ? "var(--success)" : s.state === "wait" ? "var(--text4)" : "var(--error)" }} />}</span>
                <span className="w-20 truncate">{s.remote}</span>
                <span className="text-[11px]" style={{ color: "var(--text3)", fontFamily: "inherit" }}>{s.state === "wait" ? "waiting" : s.state === "run" ? "fetching…" : s.state === "ok" ? "done" : "failed"}</span>
              </div>
            ))}
            <div className="text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>Each remote is fetched on its own</div>
          </div>
        </AnchoredMenu>
      )}

      {card && (
        <AnchoredMenu anchor={card.op === "fetch" ? fetchAnchor : card.op === "pull" ? pullAnchor : pushAnchor} minWidth={380}
          focus="[data-card-primary]" onClose={closeCard}>
          <div className="p-2.5 flex flex-col gap-2 max-w-[440px]" role="alert" data-fail-card={card.op}>
            <div className="flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
              <span className="w-[26px] h-[26px] rounded-lg inline-flex items-center justify-center shrink-0" style={{ background: "color-mix(in srgb, var(--error) 12%, transparent)", color: "var(--error-ink)" }}><WarningIcon size={ICON.sm} /></span>
              {card.title}
            </div>
            {card.rows && (
              <div className="flex flex-col gap-1">
                {card.rows.map((r) => (
                  <div key={r.remote} className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)" }}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.ok ? "var(--success)" : "var(--error)" }} />
                    <span className="w-20 truncate" style={{ fontFamily: "var(--font-mono, inherit)" }}>{r.remote}</span>
                    <span className="text-[11px]" style={{ color: "var(--text3)" }}>{r.note}</span>
                  </div>
                ))}
              </div>
            )}
            {card.body && <div className="text-[12px] leading-snug" style={{ color: "var(--text2)" }}>{card.body}</div>}
            {card.raw && <pre className="m-0 px-2 py-1.5 rounded-lg text-[10.5px] leading-relaxed whitespace-pre-wrap break-words select-text"
              style={{ background: "color-mix(in srgb, var(--error) 7%, transparent)", color: "var(--error-ink)", fontFamily: "var(--font-mono, inherit)" }}>{card.raw}</pre>}
            <div className="flex items-center gap-1.5">
              {card.next.id !== "none" && (
                <button data-card-primary onClick={next} className={CTL} style={ctl("dark")}>
                  {card.next.id === "open-remotes" ? <FolderIcon size={ICON.xs} /> : <RefreshIcon size={ICON.xs} />}{card.next.label}
                </button>
              )}
              {card.next.id !== "open-remotes" && card.op === "fetch" && (
                <button onClick={() => { closeCard(); onOpenRemotes(); }} className={CTL} style={ctl()}><FolderIcon size={ICON.xs} />Open Remotes</button>
              )}
              <span className="flex-1" />
              <button data-card-log onClick={() => { closeCard(); onOpenLog(); }} className={CTL} style={{ ...ctl(), border: "1px solid transparent", background: "transparent", color: "var(--text3)" }}>
                <TerminalIcon size={ICON.xs} />Command log
              </button>
            </div>
          </div>
        </AnchoredMenu>
      )}
    </div>
  );
}
