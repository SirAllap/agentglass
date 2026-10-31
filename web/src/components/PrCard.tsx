/**
 * THE PULL-REQUEST CARD, direction "Facet".
 *
 * This only draws. What every slot says, which colour speaks and which press is
 * offered are decided in lib/prCardView.ts, the words of every tooltip in
 * lib/prCardTips.ts, the stack chip in lib/prStackChip.ts, and the board
 * (TriageBoard) gathers the facts. The card is 336px and never shrinks: see
 * `.agx-cd` in index.css.
 *
 * No element here carries a native `title`. The tooltip is the one in
 * TipHost.tsx, asked for with `data-tip`.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { ICON } from "../lib/iconSize.ts";
import {
  ArrowRightIcon, BranchIcon, ClockIcon, CommentIcon, CopyIcon, CrossIcon, DoneIcon, EditIcon, EyeIcon, FlagIcon, FolderIcon, LayersIcon, LinkIcon,
  ListIcon, LockIcon, MergeIcon, MoreIcon, NoteIcon, PinIcon, PullRequestIcon, RefreshIcon, SparkleIcon, TagIcon, WarningIcon,
} from "../lib/glyphIcons.tsx";
import { kFormat, type CardView, type PrimaryId, type StripIcon, type Tone } from "../lib/prCardView.ts";
import { isTrunkBranch } from "../lib/prStack.ts";
import type { CardAction } from "./TriageBoard.tsx";
import type { CardFace } from "../lib/cardReviewers.ts";
import { tipAttr, type TipSpec } from "../lib/tip.ts";
import { cellTip, faceTip, idTip, labelsTip, noCardTip, noTrackerTip, notesTip, readOnlyTip, ringTip, ticketTip } from "../lib/prCardTips.ts";
import { chipAria, chipText, stackCounts, type RowTone, type StackRow } from "../lib/prStackChip.ts";
import { splitTitle } from "../lib/prCardZones.ts";
import { readingAge } from "../lib/prCardBlock.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import { dataInk } from "../lib/contrast.ts";
import { openCard } from "../lib/openCard.ts";
import type { TaskLink } from "../lib/taskLink.ts";
import { Avatar } from "./Avatar.tsx";
import { Button } from "./workspace/Chrome.tsx";

const SEG = { green: "var(--success)", red: "var(--error)", run: "var(--warning)" } as const;
const TONE_INK: Record<RowTone | Tone, string> = {
  ok: "var(--success)", bad: "var(--error)", run: "var(--warning)", info: "var(--info)", merged: "var(--merged)", mute: "var(--text3)",
};

const STRIP_ICON: Record<StripIcon, (s: number) => ReactNode> = {
  merge: (s) => <MergeIcon size={s} />, eye: (s) => <EyeIcon size={s} />, ok: (s) => <DoneIcon size={s} />,
  alert: (s) => <WarningIcon size={s} />, clock: (s) => <ClockIcon size={s} />, edit: (s) => <EditIcon size={s} />, x: (s) => <CrossIcon size={s} />,
};
const PRIMARY_ICON: Record<PrimaryId, (s: number) => ReactNode> = {
  review: (s) => <EyeIcon size={s} />, merge: (s) => <MergeIcon size={s} />, rerun: (s) => <RefreshIcon size={s} />,
  resolve: (s) => <WarningIcon size={s} />, open: (s) => <ArrowRightIcon size={s} />, clean: (s) => <SparkleIcon size={s} />,
};
const PRIMARY_TONE = { prime: "primary", ok: "ok", warn: "warn", plain: "plain" } as const;

/** A copy that said "done" for a moment. */
const COPIED_MS = 1200;

/** What the board knows about this card's stack, already decided. */
export interface StackView {
  rows: StackRow[];
  /** The list the chip opens, one entry per row. */
  list: { row: StackRow; title: string; word: string; tone: RowTone }[];
  /** The previous open member, when this card builds on one: the base chip becomes `#n`. */
  prev: { number: number; branch: string } | null;
  /** One sentence for a stack that is broken (a merged or missing base); empty when whole. */
  broken: string;
}

/** The gutter rail: a numbered node beside the card, a line to the next one. */
export interface RailView { pos: number; down: boolean }

export interface NotesChipView { tone: "error" | "warning" | "ok" | "dim"; text: string; title: string }

export interface PrCardProps {
  /** The card element, for whoever needs to know it is on screen. */
  cardRef?: React.Ref<HTMLDivElement>;
  p: PrSummary;
  cv: CardView;
  card: PrSummary["card"] | undefined;
  task: TaskLink | null;
  /** The pull request is open: a card marked done under it gets the amber dot. */
  prOpen: boolean;
  age: string;
  /** A plain sentence for the strip's tooltip: who closed it, when, how. */
  stripNote?: string;
  /** The review itself on GitHub, when the verdict has an address. */
  reviewUrl?: string;
  /** What the notes tag says in its tooltip; the count is `cv.tail.notes`. */
  notesChip: NotesChipView | null;
  /** The event line's tooltip: the sentence, the test that failed, the days of quiet. */
  eventTip: TipSpec;
  /** Unread remarks on this one, as the sentence the dot carries. */
  unread: string | null;
  pinned: boolean;
  working: boolean;
  /** Another card's action is running. */
  locked: boolean;
  dim?: boolean;
  selected?: boolean;
  lit?: boolean;
  /** The stack chip is under the pointer on this or another card of the chain. */
  chain?: "on" | "me";
  stack: StackView | null;
  rail: RailView | null;
  gutter?: boolean;
  onChain: (members: number[] | null) => void;
  /** Open another pull request in this app (a stack member, the base). */
  onOpenPr: (n: number) => void;
  onLit?: (n: number | null) => void;
  onOpen: () => void;
  onOpenFull?: () => void;
  onOpenNotes?: () => void;
  onPin: () => void;
  onAct: (what: CardAction) => void;
  onMenu: (at: { x: number; y: number }) => void;
}

const tip = (t: string | TipSpec) => tipAttr(t);
const initials = (login: string) => login.slice(0, 2).toUpperCase();

function Face({ f, size }: { f: CardFace; size: number }) {
  return (
    <span className="agx-cd-face" data-state={f.state} data-tip={tip(faceTip(f))} style={{ width: size, height: size } as CSSProperties}>
      {f.team
        ? <span className="agx-cd-face-t" style={{ fontSize: size * 0.4 }}>{initials(f.login)}</span>
        : <Avatar login={f.login} size={size} />}
    </span>
  );
}

function Faces({ faces, more, size, moreNames }: { faces: CardFace[]; more: number; size: number; moreNames?: string }) {
  if (!faces.length) return null;
  return (
    <span className="agx-cd-faces">
      {faces.map((f) => <Face key={f.login} f={f} size={size} />)}
      {more > 0 && (
        <span className="agx-cd-face agx-cd-face-more" data-tip={tip({ name: `${more} more`, text: moreNames })} style={{ height: size, minWidth: size }}>+{more}</span>
      )}
    </span>
  );
}

function Ring({ cv }: { cv: CardView }) {
  const { ring } = cv;
  const C = 2 * Math.PI * 24;
  const n = ring.green + ring.red + ring.running;
  const segs: ReactNode[] = [];
  if (n > 0) {
    const seg = C / n, gap = Math.min(3, seg * 0.3);
    for (let i = 0; i < n; i++) {
      const k = i < ring.green ? "green" : i < ring.green + ring.red ? "red" : "run";
      segs.push(
        <circle key={i} cx="28" cy="28" r="24" fill="none" stroke={SEG[k]} strokeWidth="5" strokeLinecap="butt"
          className={k === "run" ? "agx-cd-seg-run" : undefined}
          strokeDasharray={`${(seg - gap).toFixed(2)} ${(C - seg + gap).toFixed(2)}`} strokeDashoffset={(-i * seg).toFixed(2)} transform="rotate(-90 28 28)" />,
      );
    }
  }
  return (
    <div className="agx-cd-ring" data-tip={tip(ringTip(cv))}>
      <svg className="agx-cd-svg" viewBox="0 0 56 56" role="img" aria-label={ring.aria}>
        {ring.kind === "checks" ? segs
          : <circle cx="28" cy="28" r="24" fill="none" stroke="var(--border2, var(--border))" strokeWidth="5"
              strokeDasharray={ring.kind === "reading" ? undefined : "2 6"} strokeLinecap="round" className={ring.kind === "reading" ? "animate-pulse" : undefined} />}
      </svg>
      <span aria-hidden className="agx-cd-ring-i">{STRIP_ICON[cv.strip.icon](20)}</span>
      {ring.kind === "reading"
        ? <span aria-hidden className="agx-sk" style={{ width: 40, height: 10 }} />
        : <span className="agx-cd-rc">{ring.caption}</span>}
      {ring.sub && <span className="agx-cd-rs">{ring.sub}</span>}
    </div>
  );
}

export function PrCard(props: PrCardProps) {
  const { p, cv, card, task, age, stack, rail, working, locked } = props;
  const [copied, setCopied] = useState<"num" | "link" | "id" | "name" | "clink" | null>(null);
  const timer = useRef(0);
  // A long status plus the copy buttons do not fit the row: then the buttons wait under the pointer instead of sitting on the status.
  const rowRef = useRef<HTMLDivElement>(null);
  const [crowded, setCrowded] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const fit = () => {
      const left = row.querySelector<HTMLElement>(".agx-cd-cg"), ccs = row.querySelector<HTMLElement>(".agx-cd-ccs");
      setCrowded(!!left && !!ccs && left.offsetWidth + ccs.offsetWidth + 5 > row.clientWidth);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(row);
    return () => ro.disconnect();
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (what: NonNullable<typeof copied>, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(what);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (!pop) return;
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".agx-skpop, .agx-cd-sk-chip")) setPop(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(false); };
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("click", away); document.removeEventListener("keydown", esc); };
  }, [pop]);

  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const reading = cv.ring.kind === "reading";
  const menuAt = (el: HTMLElement | null, dx: number, dy: number) => {
    const r = el?.getBoundingClientRect();
    if (r) props.onMenu({ x: r.left + dx, y: r.top + dy });
  };
  const members = stack ? stack.rows.map((r) => r.number) : [];
  const { pre, rest } = splitTitle(p.title);
  const mutating = cv.primary.id === "merge" || cv.primary.id === "rerun";

  /* ---- strip ---- */
  const strip = (
    <div className="agx-cd-h" data-tip={props.stripNote ? tip({ name: cv.strip.text, text: props.stripNote }) : undefined}>
      <span aria-hidden className="flex shrink-0">{STRIP_ICON[cv.strip.icon](ICON.sm)}</span>
      {reading ? <span aria-hidden className="agx-cd-sk" /> : <span className="agx-cd-v">{cv.strip.text}</span>}
      {cv.strip.threads && (
        <span className="agx-cd-tag" style={{ "--c": "var(--warning)" } as CSSProperties} data-tip={tip({ name: "Open threads", text: cv.strip.threads.title })}>
          <CommentIcon size={ICON.xs} />{cv.strip.threads.text}
        </span>
      )}
      {stack && (
        <button type="button" className="agx-cd-sk-chip" aria-haspopup="dialog" aria-expanded={pop} aria-label={chipAria(stack.rows)}
          data-tip={tip({ name: `Stack ${chipText(stack.rows)}`, text: "Pull requests land in order, bottom first.", hint: { key: "Click", text: "See the chain" } })}
          onMouseEnter={() => props.onChain(members)} onMouseLeave={() => props.onChain(null)}
          onFocus={() => props.onChain(members)} onBlur={() => props.onChain(null)}
          onClick={(e) => { e.stopPropagation(); setPop((v) => !v); }}>
          <LayersIcon size={ICON.xs} />{chipText(stack.rows)}
        </button>
      )}
      {!reading && <Faces faces={cv.stripFaces.faces} more={cv.stripFaces.more} size={20} />}
    </div>
  );

  /* ---- title block ---- */
  const title = (
    <div className="agx-cd-t" data-tip={p.title.length > 80 ? tip({ name: p.title }) : undefined}>
      <button type="button" className="agx-cd-n" data-copied={copied === "num" ? "1" : undefined} aria-live="polite"
        data-tip={tip({ name: copied === "num" ? "Copied" : `#${p.number}`, text: copied === "num" ? undefined : "Copy the number." })}
        onClick={stop(() => copy("num", `#${p.number}`))}>
        #{p.number}
      </button>
      {pre && <span className="agx-cd-pre">{pre} | </span>}{rest}
    </div>
  );

  /* ---- ticket row ---- */
  const cardId = card ? (card.customId ?? card.id) : undefined;
  const link = card ? externalUrl(card.url) : undefined;
  const { stale, said } = card ? readingAge(card.at) : { stale: false, said: "" };
  const hasCopy = !!card;
  const copyBtn = (kind: "id" | "name" | "clink", label: string, icon: ReactNode, text: string) => (
    <button type="button" className="agx-cd-cc" data-ok={copied === kind ? "1" : undefined} aria-live="polite"
      aria-label={copied === kind ? `${label}: copied` : `${label} for ${cardId}`}
      data-tip={tip({ name: copied === kind ? "Copied" : label, detail: cardId })}
      onClick={stop(() => copy(kind, text))}>
      {copied === kind ? <DoneIcon size={ICON.xs} /> : icon}
    </button>
  );
  let ticket: ReactNode = null;
  if (cv.tracker === "card" && card && cardId) {
    const odd = card.statusKind === "done" && props.prOpen;
    const ink = card.statusColor ? dataInk(card.statusColor) : "var(--text3)";
    const who = (card.people ?? []).map((x) => x.name).join(", ");
    ticket = (
      <span className="agx-cd-cg">
        <button type="button" className="agx-cd-tk" onClick={stop(() => openCard(card.customId || card.id, card.customId))}
          aria-label={`Open ${cardId} in Tasks. ${card.status}${card.priority ? `, ${card.priority} priority` : ""}`}
          data-tip={tip({ ...ticketTip({ id: cardId, status: card.status, priority: card.priority, color: card.statusColor }, hasCopy), ...(who ? { text: `${card.status}${card.priority ? ` · ${card.priority} priority` : ""}. On ${who}.` } : null) })}>
          <FlagIcon size={ICON.xs} />{cardId}
        </button>
        {odd && <i aria-hidden className="agx-cd-odd" data-tip={tip({ name: card.status, text: "The card says this while the pull request is still open." })} />}
        <span className="agx-cd-tag" data-stale={stale ? "1" : undefined} style={{ "--c": ink } as CSSProperties}
          data-tip={tip({ name: card.status, text: `The card was in this status${said ? ` when the board was read, ${said}` : ""}.` })}>
          <span>{card.status}</span>
        </span>
      </span>
    );
  } else if (cv.tracker === "id" && task) {
    ticket = (
      <span className="agx-cd-cg">
        <button type="button" className="agx-cd-tk" onClick={stop(() => openCard(task.query, task.label))}
          aria-label={`Open ${task.label} in Tasks. Not found on your boards`} data-tip={tip(idTip(task.label))}>
          <FlagIcon size={ICON.xs} />{task.label}
        </button>
        <span className="agx-cd-tag" style={{ "--c": "var(--text4)" } as CSSProperties} data-tip={tip({ name: "Card not found", text: "This id is not on the boards saved here." })}><span>not found</span></span>
      </span>
    );
  } else if (cv.tracker === "loading") {
    ticket = <span aria-hidden className="flex items-center gap-1.5"><span className="agx-sk" style={{ width: 80, height: 16 }} /><span className="agx-sk" style={{ width: 60, height: 16 }} /></span>;
  } else if (cv.tracker === "no-card") {
    ticket = <span className="agx-cd-tk" data-none="1" tabIndex={0} data-tip={tip(noCardTip())}><LinkIcon size={ICON.xs} />No card</span>;
  } else if (cv.tracker === "no-tracker") {
    ticket = <span className="agx-cd-tk" data-none="1" tabIndex={0} data-tip={tip(noTrackerTip())}><LinkIcon size={ICON.xs} />No tracker</span>;
  }
  const trio = cv.tracker === "card" && card && cardId ? (
    <span className="agx-cd-ccs">
      {copyBtn("id", "Copy card ID", <CopyIcon size={ICON.xs} />, cardId)}
      {card.title && copyBtn("name", "Copy card name", <ListIcon size={ICON.xs} />, card.title)}
      {link && copyBtn("clink", "Copy card link", <LinkIcon size={ICON.xs} />, link)}
    </span>
  ) : null;
  const ticketRow = (
    <div className="agx-cd-m" ref={rowRef} data-crowded={crowded ? "1" : undefined}>
      <div className="agx-cd-m-l">{ticket}</div>
      {trio}
    </div>
  );

  /* ---- route ---- */
  const prev = stack?.prev ?? null;
  const offTrunk = !isTrunkBranch(p.baseRefName);
  const route = (
    <div className="agx-cd-route">
      <span className="agx-cd-chip" data-src="1" data-tip={tip({ name: p.headRefName, text: p.isCurrentBranch ? "The branch this pull request comes from. It is checked out here." : "The branch this pull request comes from." })}>
        <BranchIcon size={ICON.sm} /><span>{p.headRefName}</span>
      </span>
      <span aria-hidden className="agx-cd-arr"><ArrowRightIcon size={ICON.xs} /></span>
      {prev ? (
        <button type="button" className="agx-cd-chip" data-dest="1" data-pr="1" aria-label={`Builds on #${prev.number}. Open it`}
          data-tip={tip({ name: `Builds on #${prev.number}`, detail: prev.branch, hint: { key: "Click", text: "Open it beside the board" } })}
          onClick={stop(() => props.onOpenPr(prev.number))}
          onMouseEnter={() => props.onLit?.(prev.number)} onMouseLeave={() => props.onLit?.(null)}
          onFocus={() => props.onLit?.(prev.number)} onBlur={() => props.onLit?.(null)}>
          <PullRequestIcon size={ICON.xs} />#{prev.number}
        </button>
      ) : (
        <span className="agx-cd-chip" data-dest="1" data-off-trunk={offTrunk ? "1" : undefined}
          data-tip={tip({ name: `Merges into ${p.baseRefName}`, text: offTrunk ? "Not a trunk branch: this one is stacked on something." : undefined })}>
          <BranchIcon size={ICON.sm} /><span>{p.baseRefName}</span>
        </span>
      )}
    </div>
  );

  /* ---- cells ---- */
  const skeleton = <span aria-hidden className="agx-sk" style={{ width: 44, height: 11 }} />;
  const cell = (label: string, tone: Tone, body: ReactNode, tipSpec: TipSpec, extra?: ReactNode, attrs?: Record<string, unknown>) => (
    <div className="agx-cd-cell" data-tone={tone} data-tip={tip(tipSpec)} {...attrs}>
      <span className="agx-cd-lb">{label}</span>
      {body}
      {extra}
    </div>
  );
  const rv = cv.review;
  const reviewBody = reading ? skeleton : (
    <span className="agx-cd-rowv">
      {rv.faces.length > 0 && <Faces faces={rv.faces} more={rv.more} size={16} />}
      <span className="agx-cd-vl">{rv.word}</span>
    </span>
  );
  const reviewTip: TipSpec = props.reviewUrl
    ? { ...cellTip("Review", rv.title), hint: { key: "Click", text: "Open the review itself on GitHub" } }
    : cellTip("Review", rv.title);
  const reviewCell = props.reviewUrl
    ? (
      <button type="button" className="agx-cd-cell agx-cd-cell-btn" data-tone={rv.tone} data-tip={tip(reviewTip)}
        aria-label={`Review: ${rv.word}. Open the review on GitHub`}
        onClick={stop(() => window.open(props.reviewUrl, "_blank", "noopener"))}>
        <span className="agx-cd-lb">Review</span>{reviewBody}
      </button>
    )
    : cell("Review", rv.tone, reviewBody, reviewTip);
  const b = cv.branch;
  const third = cv.third;
  const thirdBody = reading ? skeleton
    : third.label === "Leftovers" ? <span className="agx-cd-vl">{third.word}</span>
      : (
        <>
          <span className="agx-cd-vl"><span className="agx-cd-add">+{kFormat(third.add)}</span> <span className="agx-cd-del">−{kFormat(third.del)}</span></span>
          <span className="agx-cd-db" aria-hidden>
            <i style={{ width: `${third.addShare ?? 50}%` }} /><i style={{ width: `${100 - (third.addShare ?? 50)}%` }} />
          </span>
        </>
      );
  const cells = (
    <div className="agx-cd-cells">
      {reviewCell}
      {cell(b.label, b.tone, reading ? skeleton : <span className="agx-cd-vl">{b.word}</span>, cellTip(b.label, b.title))}
      {cell(third.label, third.tone, thirdBody, cellTip(third.label, third.title))}
    </div>
  );

  /* ---- event line ---- */
  const t = cv.tail;
  const evl = (
    <div className="agx-cd-evl">
      <span className="agx-cd-et" data-tip={tip(props.eventTip)}><span className="agx-cd-ett">↳ {cv.event.empty ? "No review activity yet" : cv.event.text}</span><span className="agx-cd-eta">· {age}</span></span>
      {t.notes && props.notesChip && (
        <button type="button" className="agx-cd-tag" data-notes-chip={props.notesChip.tone} aria-label={`${props.notesChip.text}. Open the notes`}
          style={{ "--c": NOTES_INK[props.notesChip.tone] } as CSSProperties}
          data-tip={tip({ ...notesTip(p.number, t.notes.n), tag: props.notesChip.text, text: props.notesChip.title })}
          onClick={stop(() => props.onOpenNotes?.())}>
          <NoteIcon size={ICON.xs} />{t.notes.text}
        </button>
      )}
      {t.readOnly && <span className="agx-cd-tag" tabIndex={0} aria-label="Read-only" data-tip={tip(readOnlyTip(p.number))}><LockIcon size={ICON.xs} /></span>}
      {t.labels && (
        <span className="agx-cd-tag" tabIndex={0} aria-label={`Labels: ${t.labels.all.join(", ")}`} data-tip={tip(labelsTip(p.number, t.labels.all))}>
          <TagIcon size={ICON.xs} /><span>{t.labels.first}</span>{t.labels.more > 0 && <b>+{t.labels.more}</b>}
        </span>
      )}
    </div>
  );

  /* ---- footer ---- */
  const pr = cv.primary, sec = cv.secondary;
  const act = (what: CardAction) => stop(() => props.onAct(what));
  const footer = (
    <div className="agx-cd-f" onClick={(e) => e.stopPropagation()}>
      <div className="agx-cd-f-l">
        <Button size="hit" tone={PRIMARY_TONE[pr.tone]} data-tip={tip({ name: pr.lock ? "Read-only" : pr.label, text: pr.title })}
          disabled={pr.disabled || (mutating && locked)} pending={working} onClick={act(pr.id)}>
          {!working && (pr.lock ? <LockIcon size={ICON.sm} /> : PRIMARY_ICON[pr.id](ICON.sm))}
          {working ? "Working…" : pr.label}
        </Button>
        {sec.upToDate ? (
          <span className="agx-cd-utd" data-tip={tip({ name: "Up to date", text: sec.title })}><DoneIcon size={ICON.xs} />{sec.label}</span>
        ) : sec.id ? (
          <Button size="hit" tone="plain" data-tip={tip({ name: sec.label, text: sec.title })} disabled={locked || working} onClick={act(sec.id)}>{sec.label}</Button>
        ) : null}
      </div>
      <div className="agx-cd-icb">
        <span className="agx-cd-btnw">
          <Button size="hit" tone="quiet" square label={`More actions for #${p.number}`} aria-haspopup="menu"
            data-tip={tip({ name: "More actions", text: "Everything this pull request can do. Right-click the card does the same." })}
            onClick={(e) => { e.stopPropagation(); menuAt(e.currentTarget, 0, e.currentTarget.getBoundingClientRect().height + 6); }}>
            <MoreIcon size={ICON.sm} />
          </Button>
        </span>
        <span className="agx-cd-btnw">
          <Button size="hit" tone="quiet" square label={`Copy the link to #${p.number}`} data-tip={tip({ name: "Copy link", detail: `#${p.number}` })}
            style={copied === "link" ? { color: "var(--success)" } : undefined}
            onClick={(e) => { e.stopPropagation(); copy("link", p.url || ""); }}>
            {copied === "link" ? <DoneIcon size={ICON.sm} /> : <LinkIcon size={ICON.sm} />}
          </Button>
          {copied === "link" && <span className="agx-cd-copied" role="status">Link copied</span>}
        </span>
        <Button size="hit" tone="quiet" square aria-pressed={props.pinned} label={props.pinned ? `Unpin #${p.number}` : `Pin #${p.number}`}
          data-tip={tip({ name: props.pinned ? "Unpin" : "Pin", detail: `#${p.number}`, text: props.pinned ? "Take it off the bar at the top." : "Keep it on the bar at the top." })}
          style={props.pinned ? { color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" } : undefined}
          onClick={(e) => { e.stopPropagation(); props.onPin(); }}>
          <PinIcon size={ICON.sm} filled={props.pinned} />
        </Button>
      </div>
    </div>
  );

  /* ---- stack popover ---- */
  const counts = stack ? stackCounts(stack.rows) : null;
  const popover = stack && counts && pop && (
    <div className="agx-skpop" role="dialog" aria-label={`Stack of ${stack.rows.length}`} onClick={(e) => e.stopPropagation()}>
      <div className="agx-skpop-h">
        Stack of {stack.rows.length}
        <small>{counts.merged} merged, {counts.open} open. Pull requests land in order, bottom first.</small>
        {stack.broken && <small>{stack.broken}</small>}
      </div>
      {stack.list.map(({ row, title: t2, word, tone }) => (
        <button key={row.number} type="button" className="agx-skpop-r" data-me={row.me ? "1" : undefined} data-gone={row.kind === "merged" ? "1" : undefined}
          style={{ "--c": TONE_INK[tone] } as CSSProperties}
          data-tip={tip(row.me ? "You are here" : "Open this pull request beside the board")}
          onClick={() => { setPop(false); if (!row.me) props.onOpenPr(row.number); }}>
          <i className="agx-skpop-nd">{row.pos}</i>
          <span className="agx-skpop-n">#{row.number}</span>
          <span className="agx-skpop-tt">{t2}</span>
          <em className="agx-skpop-w">{word}</em>
        </button>
      ))}
    </div>
  );

  const body = (
    <div ref={props.cardRef} onClick={props.onOpen} role="button" tabIndex={0} data-pr={p.number}
      onDoubleClick={(e) => { if (props.onOpenFull && !(e.target as HTMLElement).closest("button, a")) props.onOpenFull(); }}
      aria-label={cv.aria} aria-haspopup="menu"
      data-tone={cv.tone} data-kind={cv.kind}
      data-dim={props.dim ? "1" : undefined} data-lit={props.lit ? "1" : undefined} data-selected={props.selected ? "1" : undefined}
      data-busy={working ? "1" : undefined} data-chain={props.chain}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); props.onMenu({ x: e.clientX, y: e.clientY }); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onOpen(); }
        /* Shift+F10 and the menu key open the menu where the card is, for a keyboard that has no right button. */
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); menuAt(e.currentTarget, 24, 24); }
      }}
      className="agx-cd">
      {props.unread && <span className="agx-cd-unread" role="img" aria-label={props.unread} data-tip={tip(props.unread)} />}
      {strip}
      {popover}
      <div className="agx-cd-body">
        <Ring cv={cv} />
        <div className="agx-cd-main">
          {title}
          {ticketRow}
          {route}
        </div>
      </div>
      {cells}
      {evl}
      {cv.leftover && (
        <div className="agx-cd-lf" data-tone={cv.leftover.tone} data-leftover-line="" data-tip={tip(cv.leftover.title)}>
          {cv.leftover.tone === "run" ? <i className="agx-cd-lf-bar" aria-hidden /> : <FolderIcon size={ICON.sm} />}<span>{cv.leftover.text}</span>
        </div>
      )}
      {footer}
    </div>
  );
  if (!rail) return props.gutter ? <div className="agx-cd-gut">{body}</div> : body;
  return (
    <div className="agx-cd-rail" data-down={rail.down ? "1" : undefined} data-tone={cv.tone}>
      <span aria-hidden className="agx-cd-node" data-me={props.selected ? "1" : undefined}>{rail.pos}</span>
      {body}
    </div>
  );
}

const NOTES_INK = { error: "var(--error)", warning: "var(--warning)", ok: "var(--success)", dim: "var(--text3)" } as const;
