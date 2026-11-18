/*
 * The comfortable Jira board tile, below its title: the one thing that needs you, the card's own pull requests as read-only
 * tickets, and the Jira actions. This is a TASK card. A pull request is information plus one direct link that opens it; nothing
 * here writes to GitHub. Every fact comes from stores the PR board already fills (jiraTileData.ts): the tile never fetches.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { CardPr } from "../../../lib/cardPrPick.ts";
import { cardPrsOf, cardPrVersion, onCardPrs } from "../../../lib/cardPrStore.ts";
import { cardChecksVersion, ciChipFor, onCardChecks, type CardWorker, type FinishedRun } from "../../../lib/jiraCardWork.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { onListChecks } from "../../../lib/prListChecks.ts";
import { onBehind } from "../../../lib/prBehindStore.ts";
import { tilePrOf } from "../../../lib/jiraTileData.ts";
import { actionTip, childBar, foldSecondary, compactPrChip, HEADER_TIP, inlinePrs, mentionChip, moveView, ticketLayout, type MoveUi, popoverPlacement, tileAction, tileOwner, tileHeader, type HeaderKind, type TilePr } from "../../../lib/jiraTileModel.ts";
import { kFormat } from "../../../lib/prCardView.ts";
import { ArrowRightIcon, BlockedIcon, EyeIcon, PlayIcon, RefreshIcon, WarningIcon, BoltIcon, ClockIcon, DoneIcon, FlagIcon, LinkIcon, MoreIcon, PullRequestIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { openPr, openPrs, prRefFromUrl } from "../../../lib/openPrs.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { openLive } from "../detail/cardWorkActions.ts";
import { askDock } from "./menus/dockIntent.ts";
import { openFlightPlan } from "../../../lib/flightPlanNav.ts";
import { keyOf } from "./laneModel.ts";
import { api } from "../../../lib/api.ts";
import { batonStep, movesCard, rerunPending, rerunSig, SAID_MS, taskNow, type TaskNowAction } from "../../../lib/taskNow.ts";
import { useTileRoot } from "../../../lib/tileRoot.ts";
import { conflictBriefing, conflictHandoff } from "../../../lib/conflictBrief.ts";
import { requestTermIssue } from "../../../lib/termIssue.ts";
import { ChangedMark } from "./ChangedMark.tsx";
import type { Blocker } from "../../../lib/blockers.ts";

function openTilePr(p: Pick<TilePr, "url" | "number" | "state">): void {
  const ref = prRefFromUrl(p.url);
  if (ref) openPr(ref.repo, p.number); else openPrs(String(p.number), p.state === "OPEN" ? "open" : "all");
}

/** The tile's own reads: the card's PRs (own and mentions) and a re-render whenever the board's stores move. */
function useTilePrs(card: ProviderTask): { own: TilePr[]; mentions: CardPr[] } {
  useSyncExternalStore(onCardPrs, cardPrVersion, cardPrVersion);
  useSyncExternalStore(onCardChecks, cardChecksVersion, cardChecksVersion);
  const [, bump] = useState(0);
  useEffect(() => {
    const a = onListChecks(() => bump((n) => n + 1));
    const b = onBehind(() => bump((n) => n + 1));
    return () => { a(); b(); };
  }, []);
  const e = cardPrsOf(card.id, keyOf(card), "", "", "jira");
  return { own: (e?.prs ?? []).map(tilePrOf), mentions: e?.mentions ?? [] };
}

/** The mockup-07 baton line: NOW, the card's next step in one word, the mini ring of the lead PR's checks, and the one action that does it. Every action is the person's click, one request at a time. */
const NOW_ICON: Partial<Record<TaskNowAction, (p: { size: number }) => ReactNode>> = {
  rerun: (p) => <RefreshIcon {...p} />, review: (p) => <EyeIcon {...p} />, start: (p) => <PlayIcon {...p} />, "fix-conflicts": (p) => <WarningIcon {...p} />,
  "open-pr": (p) => <ArrowRightIcon {...p} />, "finish-draft": (p) => <ArrowRightIcon {...p} />, "ready-for-qa": (p) => <ArrowRightIcon {...p} />,
};

function NowLine({ card, own, hasWorker, blockedBy, nextStatus, writable, onMoveNext, moving }: { card: ProviderTask; own: readonly TilePr[]; hasWorker: boolean; blockedBy?: string | undefined; nextStatus: string | null; writable: boolean; onMoveNext?: ((card: ProviderTask, to: string) => void) | undefined; moving: boolean }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [reran, setReran] = useState<string | null>(null);
  const root = useTileRoot();
  const lead = own.find((p) => p.state === "OPEN") ?? own[0] ?? null;
  const open = card.statusKind === "other" || card.statusKind === "open";
  const now = taskNow({
    status: card.statusKind === "done" ? "done" : /\bqa\b/i.test(card.status ?? "") ? "qa" : /to ?do|backlog|open/i.test(card.status ?? "") && !lead ? "todo" : "doing",
    ...(blockedBy ? { blockedBy } : {}),
    pr: lead ? { number: lead.number, state: lead.state, draft: lead.draft } : null,
    ...(lead?.state === "OPEN" ? { ci: { state: lead.ci.state, failed: lead.ci.failed }, review: lead.review.kind, conflicts: lead.mergeable === "CONFLICTING" } : {}),
  });
  const ci = lead?.state === "OPEN" ? lead.ci : null;
  // A said line is an answer to one click: it goes after a few seconds, and when the card's action or PR is no longer the one clicked.
  useEffect(() => { setSaid(""); setReran(null); }, [now.action, lead?.number]);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), SAID_MS);
    return () => clearTimeout(t);
  }, [said]);
  // A re-run stays off until the rollup the click was made on has changed.
  useEffect(() => { if (reran !== null && !rerunPending(reran, ci)) setReran(null); }, [reran, ci?.state, ci?.failed]);
  if (!open || hasWorker || now.action === "none" && !now.word && !now.waiting) return null;
  // Mockup 07 colours only the key word ("3 failed", "conflicts"); the rest of the line stays dark.
  const keyTone = now.action === "rerun" || now.action === "fix-conflicts" ? "var(--error-ink)" : "var(--text2)";
  const at = now.key ? now.word.indexOf(now.key) : -1;
  const running = ci ? Math.max(0, ci.total - ci.passed - ci.failed) : 0;
  const start = movesCard(now.action);
  const wait = busy || (start && moving) || rerunPending(reran, ci);
  const go = async (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    if (wait) return;
    if (start) { if (nextStatus && writable) onMoveNext?.(card, nextStatus); return; }
    if (!lead) return;
    if (now.action !== "rerun" && now.action !== "fix-conflicts") { openTilePr(lead); return; }
    const ref = prRefFromUrl(lead.url);
    if (!ref || !root) { openTilePr(lead); return; }
    setBusy(true); setSaid("");
    if (now.action === "fix-conflicts") {
      // The launch the PR detail's "Send to terminal" makes for a conflict: merge in a worktree of its own, brief, tmux window.
      const p = await api.prConflict(root, lead.number).catch(() => ({ ok: false, error: "Could not reach the server" } as Awaited<ReturnType<typeof api.prConflict>>));
      if (!p.ok || !p.root) { setBusy(false); setSaid(p.error || "Could not prepare the merge"); return; }
      if (p.clean) { setBusy(false); setSaid("Merged cleanly: nothing to resolve, just push it"); return; }
      const files = p.conflicts ?? [];
      const wt = p.root;
      const base = lead.base ?? "";
      const h = await conflictHandoff(
        conflictBriefing(wt, { name: lead.branch || `#${lead.number}`, base, upstream: null, ahead: 0, behind: 0, detached: false }, undefined, "merging", files),
        () => api.prConflictPrompt({ worktree: wt, files, number: lead.number, repo: ref.repo, base, title: lead.title ?? "" }),
      );
      const done = await requestTermIssue(wt, `conflict-${lead.number}`, h.prompt, true, false, "", h.model, h.effort, true);
      setBusy(false);
      setSaid(done.ok ? (done.reused ? `Claude already works on #${lead.number}` : `Claude is on #${lead.number} in a tmux window`) : `Claude was not started: ${done.error}`);
      return;
    }
    // The same rerun the pull request detail calls, with the repo root the board maps to; the server's own refusal is shown as it came.
    const r = await api.prRerun(root, lead.number).catch((x: unknown) => ({ ok: false, error: String(x) }));
    setBusy(false);
    if (!r.ok) setSaid(r.error || "GitHub would not re-run the failed checks");
    else { setReran(rerunSig(ci)); setSaid(`Re-running ${ci?.failed ?? ""}…`.replace(" …", "…")); }
  };
  const showBtn = !!now.label && (start ? !!nextStatus && writable : !!lead);
  const nowRow = now.word ? (
    <div className="agx-jt-now" data-action={now.action} style={{ ["--c" as string]: keyTone }}>
      <span className="k">NOW</span>
      {!(ci && ci.total > 0) && now.word && (
        <span className="ring" aria-hidden data-baton>{[1, 2, 3].map((n) => <i key={n} data-k={n <= batonStep(now.action) ? (now.action === "start" ? "run" : "ok") : "off"} style={{ flexGrow: 1 }} />)}</span>
      )}
      {ci && ci.total > 0 && (
        <span className="ring" aria-hidden>
          {ci.passed > 0 && <i data-k="ok" style={{ flexGrow: ci.passed }} />}
          {ci.failed > 0 && <i data-k="bad" style={{ flexGrow: ci.failed }} />}
          {running > 0 && <i data-k="run" style={{ flexGrow: running }} />}
        </span>
      )}
      <span className="w agx-jb-trunc" role={said ? "alert" : undefined}>{said || (at >= 0 ? <>{now.word.slice(0, at)}<b className="key">{now.key}</b>{now.word.slice(at + now.key!.length)}</> : now.word)}</span>
      {showBtn && <button type="button" aria-busy={wait || undefined} aria-disabled={wait || undefined} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { void go(e); }}>{NOW_ICON[now.action]?.({ size: ICON.xs })}{now.label}</button>}
    </div>
  ) : null;
  return (
    <>
      {now.waiting && <div className="agx-jt-wait">{now.waiting}</div>}
      {nowRow}
    </>
  );
}

const HEAD_ICON: Record<HeaderKind, (p: { size: number }) => ReactNode> = {
  blocked: (p) => <BlockedIcon {...p} />,
  "child-blocked": (p) => <FlagIcon {...p} />,
  worker: (p) => <BoltIcon {...p} />,
  "ci-failing": (p) => <FlagIcon {...p} />,
  waiting: (p) => <ClockIcon {...p} />,
  ready: (p) => <DoneIcon {...p} />,
  quiet: (p) => <FlagIcon {...p} />,
};
const HEAD_TONE: Record<HeaderKind, string> = { blocked: "var(--error-ink)", "child-blocked": "var(--error-ink)", worker: "var(--info)", "ci-failing": "var(--error-ink)", waiting: "var(--warning-ink)", ready: "var(--success-ink)", quiet: "var(--text3)" };

/** "2h", "16m", "4d": how long since the card last moved. */
export function tileAge(updated: number | undefined, now = Date.now()): string {
  if (!updated) return "";
  const m = Math.max(0, Math.round((now - updated) / 60_000));
  return m < 60 ? `${Math.max(1, m)}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const prTone = (p: TilePr): string =>
  p.state === "MERGED" ? "var(--info-ink, var(--text2))" : p.state === "CLOSED" ? "var(--text3)"
    : p.ci.state === "failing" ? "var(--error-ink)" : p.ci.state === "passing" ? "var(--success-ink)" : p.ci.state === "running" ? "var(--warning-ink)" : "var(--text3)";
const prWord = (p: TilePr): string => (p.draft ? "Draft" : p.state === "MERGED" ? "Merged" : p.state === "CLOSED" ? "Closed" : p.state === "OPEN" ? "Open" : "Linked");
const reviewWord = (p: TilePr): string | null => {
  const r = p.review;
  if (r.kind === "unknown" || r.kind === "none") return null;
  const who = r.who ? ` ${r.who}` : "";
  return r.kind === "approved" ? `approved${who}` : r.kind === "changes" ? `changes${who}` : r.kind === "commented" ? `commented${who}` : `waiting${who}`;
};
/** An open PR whose checks nobody has read yet says "CI loading" while the board's own list load is in flight. */
const ciLoading = (p: TilePr): boolean => p.state === "OPEN" && p.ci.state === "unknown" && ciChipFor(p.url).loading;
const ciWord = (p: TilePr): string =>
  ciLoading(p) ? "CI loading" : p.ci.state === "failing" ? `${p.ci.failed} failing` : p.ci.state === "unknown" ? "CI not read" : `${p.ci.passed}/${p.ci.total}`;

/** One pull request as a read-only ticket: number, state, base and checks, then review, behind and changes. A click opens it; nothing else happens. */
function PrTicket({ p, narrow }: { p: TilePr; narrow: { facts: boolean; base: boolean } }) {
  const live = p.state === "OPEN";
  const review = live ? reviewWord(p) : null;
  const facts = [review, live && p.behind ? `↓${p.behind} behind` : null, p.additions !== null && p.deletions !== null ? `+${kFormat(p.additions)} −${kFormat(p.deletions)}` : null].filter(Boolean);
  return (
    <button type="button" className="agx-jt-pr" style={{ ["--c" as string]: prTone(p) }} data-ci={live ? p.ci.state : undefined} data-merged={p.state === "MERGED" ? "" : undefined}
      aria-label={`Open pull request #${p.number}, ${prWord(p)}${p.base ? ` into ${p.base}` : ""}, ${live ? ciWord(p) : ""}`}
      data-tip={tipAttr({ name: `${prWord(p)} pull request`, detail: `#${p.number}`, ...(p.title ? { text: p.title } : {}), hint: { text: "Open it" } })}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openTilePr(p); }}>
      <span className="r1"><PullRequestIcon size={ICON.xs} /><b className="n">#{p.number}</b><span className="ext" aria-hidden>↗</span><span>{prWord(p)}</span>
        {p.base && narrow.base && <span className="base"><ArrowRightIcon size={ICON.xs} /><span className="agx-jb-trunc">{p.base}</span></span>}
        <span className="rt" data-ci={p.ci.state}>{p.state === "MERGED" || live ? ciWord(p) : ""}</span></span>
      {live && narrow.facts && facts.length > 0 && <span className="r2">{facts.map((f, i) => <span key={i}>{f}</span>)}</span>}
    </button>
  );
}

/** The popover of every PR the card has: its own first, mentions muted. Placed inside its lane, closed on scroll, Escape or an outside press. */
function TilePopover({ anchor, own, mentions, onClose }: { anchor: HTMLElement; own: readonly TilePr[]; mentions: readonly CardPr[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const laneEl = anchor.closest<HTMLElement>(".agx-jb-col") ?? anchor.closest<HTMLElement>(".agx-jb-cards") ?? document.body;
    const l = laneEl.getBoundingClientRect(), a = anchor.getBoundingClientRect(), r = el.getBoundingClientRect();
    const p = popoverPlacement(a, l, { w: r.width, h: r.height });
    setAt({ left: p.left, top: p.top });
  }, [anchor]);
  useEffect(() => {
    const close = () => onClose();
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  const laneW = (anchor.closest<HTMLElement>(".agx-jb-col") ?? anchor).getBoundingClientRect().width;
  return createPortal(
    <div ref={ref} className="agx-jt-pop" role="dialog" aria-label="This card's pull requests" style={{ left: at?.left ?? 0, top: at?.top ?? 0, width: Math.min(300, laneW || 300), zIndex: LAYER.menu, visibility: at ? "visible" : "hidden" }}
      onClick={(e) => e.stopPropagation()}>
      <div className="gh"><b>This card's PRs</b><span>{own.length}</span></div>
      {own.map((p) => (
        <button key={p.number} type="button" className="pr" style={{ ["--c" as string]: prTone(p) }} onClick={() => { onClose(); openTilePr(p); }}>
          <PullRequestIcon size={ICON.xs} /><b className="n">#{p.number}</b><span>{prWord(p)}</span><span className="rt">{p.state === "OPEN" || p.state === "MERGED" ? ciWord(p) : ""}</span>
        </button>
      ))}
      {mentions.length > 0 && <div className="gh mu"><span>Mentions</span><span>{mentions.length}</span></div>}
      {mentions.map((m) => (
        <button key={m.number} type="button" className="pr m" onClick={() => { onClose(); openTilePr({ url: m.url, number: m.number, state: m.state === "OPEN" ? "OPEN" : "" }); }}>
          <LinkIcon size={ICON.xs} /><span className="agx-jb-trunc">#{m.number} {m.title}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export interface TileBodyProps {
  card: ProviderTask;
  blockedBy: readonly Blocker[];
  worker: CardWorker | null;
  /** The last agent session, ended lately: shown when no worker is live, so a card an agent just left still says so. */
  ended?: FinishedRun | null | undefined;
  /** Opens a card by its key: the blocking card. */
  onOpenKey?: ((key: string) => void) | undefined;
  /** The card menu (moves, open in Jira, copy): the tile's "..." reuses it. */
  onMenu?: ((e: React.MouseEvent, card: ProviderTask) => void) | undefined;
  /** The column after this card's: "Move to" it. Null on the last one. */
  nextStatus?: string | null;
  /** Jira writes allowed (Changes in Jira on). */
  writable?: boolean;
  /** Move this card to a status through the board's own move flow (its confirm bar, same rules as a drop). */
  onMoveNext?: ((card: ProviderTask, to: string) => void) | undefined;
  /** Open the card on its people picker: the pane confirms the assignment. */
  onAssign?: ((card: ProviderTask) => void) | undefined;
  /** The lane's width in px, which the board knows: a narrow lane drops the ticket's second row. */
  laneWidth?: number;
  /** The board's own move state for this card: in flight, or failed with the reason. */
  moveUi?: MoveUi | undefined;
  /** The board draws this card's sub-task progress itself (family row): the tile leaves its own bar out. */
  hideKids?: boolean;
}

/** The part of a comfortable tile under the title. */
/** Compact density: one chip, the lead PR's number and CI, and +N for the rest. Read-only, opens the PR. */
const dollars = (usd: number): string => `$${usd.toFixed(2)}`;

/** The live worker on the card: its title, state and what it has cost so far. */
/** An agent left this card in the past two hours: quiet, no dot, so it never reads as one still working. */
function EndedLine({ r, onOpenKey }: { r: FinishedRun; onOpenKey?: ((key: string) => void) | undefined }) {
  return (
    <div className="agx-jb-work" data-ended="" role="button" tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpenKey?.(r.key); askDock(r.key, "work"); }} data-tip={tipAttr({ name: r.title, detail: "ended", text: `Its last session ended ${new Date(r.at).toLocaleTimeString()}, ${dollars(r.cost)} in all. Click to open the card on its Work tab, where what it did is.` })}>
      <DoneIcon size={ICON.xs} />
      <span className="agx-jb-trunc agx-jb-work-name">Agent finished {fmtAgo(r.at)} ago</span>
      <span className="agx-jb-gap" />
      <span className="agx-jb-cost">{dollars(r.cost)}</span>
    </div>
  );
}

function WorkerLine({ w }: { w: CardWorker }) {
  return (
    <div className="agx-jb-work" role="button" tabIndex={-1} style={{ cursor: "pointer" }}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openLive(null, w); }}
      data-tip={tipAttr({ name: w.title, detail: `${w.status}${w.model ? ` · ${w.model}` : ""}`, text: `${w.doing ? `Now: ${w.doing}. ` : ""}${dollars(w.cost)} so far. Click to bring its tab forward.` })}>
      <span className="agx-jb-work-dot" data-live={w.status === "working" ? "" : undefined} data-needs={w.status === "waiting" ? "" : undefined} aria-hidden />
      <span className="agx-jb-trunc agx-jb-work-name">{w.title}</span>
      {/* Waiting is waiting on a person: said in words, in the warning ink, the one state a glance at the board must catch. */}
      {w.status === "waiting" ? <span className="agx-jb-work-role" data-needs="">· needs you</span> : <span className="agx-jb-work-role">· {w.status}</span>}
      <span className="agx-jb-gap" />
      <span className="agx-jb-cost">{dollars(w.cost)}</span>
    </div>
  );
}

export function CompactPr({ card }: { card: ProviderTask }) {
  const { own } = useTilePrs(card);
  const chip = compactPrChip(own);
  if (!chip) return null;
  const p = chip.lead;
  const live = p.state === "OPEN";
  return (
    <button type="button" className="agx-jt-cmp" style={{ ["--c" as string]: prTone(p) }}
      aria-label={`Open pull request #${p.number}, ${prWord(p)}${live ? `, ${ciWord(p)}` : ""}${chip.more ? `, and ${chip.more} more` : ""}`}
      data-tip={tipAttr({ name: `${prWord(p)} pull request`, detail: `#${p.number}`, ...(p.title ? { text: p.title } : {}), hint: { text: "Open it" } })}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openTilePr(p); }}>
      <PullRequestIcon size={ICON.xs} /><b className="n">#{p.number}</b>{(live || p.state === "MERGED") && <span className="rt">{ciWord(p)}</span>}{chip.more > 0 && <span className="m">+{chip.more}</span>}
    </button>
  );
}

export function TileBody({ card, blockedBy, worker, ended = null, onOpenKey, onMenu, nextStatus = null, writable = true, onMoveNext, onAssign, moveUi, laneWidth = 0, hideKids = false }: TileBodyProps) {
  const { own, mentions } = useTilePrs(card);
  const head = tileHeader({ blockedBy, worker: !!worker, prs: own, children: card.children });
  const bar = childBar(card.children);
  const layout = ticketLayout(laneWidth);
  const { primary: act, secondary } = tileAction({ blockedBy, worker: !!worker, header: head.kind, nextStatus, writable, childKey: bar?.blocked?.key, owner: tileOwner(card), done: card.statusKind === "done" });
  const mv = moveView(moveUi, act);
  const run = (a: NonNullable<typeof act>) => {
    if (a.disabled || mv.busy) return;
    if (a.kind === "open-blocker" || a.kind === "open-child") onOpenKey?.(a.key);
    else if (a.kind === "open-worker") openLive(null, worker);
    else if (a.kind === "move-next") onMoveNext?.(card, a.to);
    else if (a.kind === "assign") onAssign?.(card);
    else openFlightPlan({ compose: { taskId: card.id, request: `${keyOf(card)} ${card.title}` } });
  };
  const { inline, more } = inlinePrs(own);
  const mention = mentionChip(mentions.length);
  const folded = !!act && !!secondary && foldSecondary({ laneWidth, primary: mv.label, secondary: secondary.label, mentions: mention !== null });
  const [pop, setPop] = useState<HTMLElement | null>(null);
  const age = tileAge(card.updated);
  const key = keyOf(card);
  const toggle = (e: React.MouseEvent<HTMLElement>) => { e.stopPropagation(); setPop((cur) => (cur ? null : e.currentTarget)); };
  return (
    <>
      {head.kind !== "quiet" && <div className="agx-jt-attn" data-kind={head.kind} style={{ ["--c" as string]: HEAD_TONE[head.kind] }} data-tip={tipAttr({ name: head.text, text: HEADER_TIP[head.kind] })}>
        {HEAD_ICON[head.kind]({ size: ICON.sm })}<span className="x">{head.text}</span>{age && <span className="tm" data-tip={tipAttr(`Updated in Jira ${new Date(card.updated!).toLocaleString()}`)}>{age}</span>}
      </div>}
      <ChangedMark id={card.id} />
      {worker ? <WorkerLine w={worker} /> : ended && <EndedLine r={ended} onOpenKey={onOpenKey} />}
      <NowLine card={card} own={own} hasWorker={!!worker} blockedBy={blockedBy[0] ? (typeof blockedBy[0] === "string" ? blockedBy[0] : blockedBy[0].key) : undefined} nextStatus={nextStatus} writable={writable} onMoveNext={onMoveNext} moving={mv.busy} />
      {own.length > 0 && (
        <div className="agx-jt-prs">
          {inline.map((p) => <PrTicket key={p.number} p={p} narrow={layout} />)}
          {more > 0 && (
            <button type="button" className="agx-jt-more" aria-haspopup="dialog" aria-expanded={!!pop} aria-label={`${more} more pull requests`} data-tip={tipAttr(`${more} more pull requests`)}
              onPointerDown={(e) => e.stopPropagation()} onClick={toggle}>+{more}</button>
          )}
        </div>
      )}
      {bar && !hideKids && (
        <div className="agx-jt-kids" data-tip={tipAttr({ name: `${bar.done} of ${bar.total} sub-tasks done`, text: "One square per sub-task in Jira order: green done, accent in progress, red blocked, grey to do." })}>
          <b className="tc">{bar.done}/{bar.total}</b>
          <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={bar.total} aria-valuenow={bar.done} aria-label={`${bar.done} of ${bar.total} sub-tasks done`}><i style={{ width: `${Math.round((bar.done / bar.total) * 100)}%` }} /></span>
          <span className="sq" aria-hidden>{bar.squares.map((k, i) => <i key={i} data-k={k} />)}{bar.hidden > 0 && <em>+{bar.hidden}</em>}</span>
        </div>
      )}
      {mv.error && (
        <div className="agx-jt-err" role="alert">
          <FlagIcon size={ICON.xs} /><span className="agx-jb-trunc" data-tip={tipAttr(mv.error)}>{mv.error}</span>
          {mv.retryTo && <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onMoveNext?.(card, mv.retryTo!); }}>Retry</button>}
        </div>
      )}
      <div className="agx-jt-acts">
        {act && (
          <button type="button" className="agx-jt-act" data-kind={act.kind} aria-disabled={act.disabled ? true : undefined} aria-busy={mv.busy || undefined} data-busy={mv.busy ? "" : undefined} data-tip={tipAttr(actionTip(act, key))}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); run(act); }}>{mv.busy && <span className="agx-jt-spin" aria-hidden />}<span className="agx-jt-lbl">{mv.label}</span></button>
        )}
        {secondary && !folded && (
          <button type="button" className="agx-jt-act agx-jt-hov" data-kind="assign" aria-disabled={secondary.disabled ? true : undefined} data-tip={tipAttr(actionTip(secondary, key))}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); run(secondary); }}><span className="agx-jt-lbl">{secondary.label}</span></button>
        )}
        <span className="agx-jb-gap" />
        {mention && (
          <button type="button" className="agx-jt-ment" aria-haspopup="dialog" aria-expanded={!!pop} aria-label={mention.tip} data-tip={tipAttr(mention.tip)}
            onPointerDown={(e) => e.stopPropagation()} onClick={toggle}><LinkIcon size={ICON.xs} />{mention.count}</button>
        )}
        {onMenu && (
          <button type="button" className="agx-jt-dots" aria-label={`Menu for ${key}`} aria-haspopup="menu" data-tip={tipAttr("Open, copy or open in Jira - or right-click")}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onMenu(e, card)}><MoreIcon size={ICON.sm} /></button>
        )}
      </div>
      {pop && <TilePopover anchor={pop} own={own} mentions={mentions} onClose={() => setPop(null)} />}
    </>
  );
}
