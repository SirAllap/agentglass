/*
 * The parts the Images, Volumes and Networks views share: the shape a thing
 * wears, container chips that go to the container, the size bar, the one
 * Remove button and the "..." menu, the two-step confirm that sits inside the
 * card, and the pictures for loading, empty, error and "nothing matches".
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DockerContainer } from "../../../../shared/types.ts";
import { displayName, KINDS, kindOf, READ_ONLY_REASON } from "../../lib/dockerState.ts";
import { SHAPES, type AnswerSpec, type CardIcon, type ShapeKey, type Worn, type XMenuEntry } from "../../lib/dockerResourceUi.ts";
import { CopyIcon, DiskIcon, DoneIcon, FolderIcon, LockIcon, MoreIcon, RefreshIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { BroomIcon, CubeIcon, MinusCircleIcon, TrashIcon } from "./DockerIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { useEscapeClose } from "../../lib/useDismiss.ts";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { AnswerCard } from "./AnswerCards.tsx";
import { GlyphSvg } from "./Glyphs.tsx";
import { Item } from "./RowMenu.tsx";

const tint = (v: string) => ({ "--tint": v }) as CSSProperties;

/* ---- the shape: colour, form and word travel together ---- */
const DRAW: Record<ShapeKey, (t: string) => ReactNode> = {
  use: (t) => <circle cx="8" cy="8" r="6" fill={t} />,
  idle: (t) => <circle cx="8" cy="8" r="5.2" fill="none" stroke={t} strokeWidth="1.8" />,
  kept: (t) => (<><circle cx="8" cy="8" r="5.6" fill="none" stroke={t} strokeWidth="1.8" /><circle cx="8" cy="8" r="2" fill={t} /></>),
  safe: (t) => (<>
    <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3" fill={`color-mix(in srgb, ${t} 16%, var(--bg))`} stroke={t} strokeWidth="1.6" />
    <path d="M5 11 11 5M5 7.6 7.6 5M8.4 11 11 8.4" stroke={t} strokeWidth="1.4" strokeLinecap="round" />
  </>),
  dang: (t) => <circle cx="8" cy="8" r="5.2" fill="none" stroke={t} strokeWidth="1.8" strokeDasharray="2.6 2.4" />,
};

export function Shape({ worn }: { worn: Worn }) {
  return (
    <span className="dk-g" role="img" aria-label={worn.word} title={worn.word}>
      <svg viewBox="0 0 16 16" aria-hidden>{DRAW[worn.shape](SHAPES[worn.shape].tone)}</svg>
    </span>
  );
}

export function Badge({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return <span className="dk-badge" style={tint(tone)} title={title}>{children}</span>;
}

/* ---- containers named on a card ---- */
export function ContainerChip({ c, onGo, label }: { c: DockerContainer; onGo: (id: string) => void; label?: string }) {
  const kind = kindOf(c);
  const title = `${c.name} · ${KINDS[kind].word}. Open it in Containers`;
  return (
    <button type="button" className="dk-cav" title={title} aria-label={title} onClick={(e) => { e.stopPropagation(); onGo(c.id); }}>
      <GlyphSvg kind={kind} /><span>{label ?? displayName(c)}</span>
    </button>
  );
}

/** Up to three chips, then "+N" with the rest in its tooltip. */
export function ContainerChips({ cs, none, onGo }: { cs: DockerContainer[]; none: string; onGo: (id: string) => void }) {
  if (!cs.length) return <span className="dk-xe">{none}</span>;
  return (
    <span className="dk-avs">
      {cs.slice(0, 3).map((c) => <ContainerChip key={c.id} c={c} onGo={onGo} />)}
      {cs.length > 3 && <span className="dk-cav" data-rest title={cs.slice(3).map((c) => c.name).join(", ")}>+{cs.length - 3}</span>}
    </span>
  );
}

export function SizeBar({ bytes, max, tone }: { bytes: number | null; max: number; tone: string }) {
  if (bytes == null || !max) return <span className="dk-xbar" />;
  return <span className="dk-xbar" aria-hidden><i style={{ width: `${Math.max(2, Math.round((bytes / max) * 100))}%`, ["--t" as string]: tone }} /></span>;
}

/* ---- the one action and its menu ---- */
export function RemoveButton({ label, off, reason, readOnly, pending, onClick, lock }: {
  label: string; off: boolean; reason?: string; readOnly: boolean; pending?: boolean; onClick: () => void;
  /** A lock instead of a cross: this one is never removable from here. */
  lock?: boolean;
}) {
  const tip = readOnly ? READ_ONLY_REASON : off ? reason : "Remove…";
  return (
    <button type="button" className="dk-act" style={{ "--tone": "var(--error)" } as CSSProperties} aria-label={label} title={tip} aria-busy={pending || undefined}
      disabled={off || readOnly || pending} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {lock ? <LockIcon size={ICON.sm} /> : <TrashIcon size={ICON.sm} />}
    </button>
  );
}

export function MoreButton({ label, open, onMenu }: { label: string; open: boolean; onMenu: (el: HTMLElement) => void }) {
  return (
    <button type="button" className="dk-more" data-open={open || undefined} aria-label={`More for ${label}`} aria-haspopup="menu" aria-expanded={open} title="More"
      onClick={(e) => { e.stopPropagation(); onMenu(e.currentTarget); }}>
      <MoreIcon size={ICON.sm} />
    </button>
  );
}

const ICON_OF = {
  copy: <CopyIcon size={ICON.sm} />, disk: <DiskIcon size={ICON.sm} />, look: <FolderIcon size={ICON.sm} />, rm: <TrashIcon size={ICON.sm} />,
};

/** One open menu at a time: which card it belongs to, and the button it hangs from. */
export function useMenu() {
  const [key, setKey] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  return { key, anchor, open: (k: string) => (el: HTMLElement) => { anchor.current = el; setKey(k); }, close: () => setKey(null) };
}

export function XMenu({ anchor, entries, onPick, onClose }: {
  anchor: React.RefObject<HTMLElement | null>; entries: XMenuEntry[]; onPick: (verb: "copy" | "disk" | "look" | "rm") => void; onClose: () => void;
}) {
  return (
    <AnchoredMenu anchor={anchor} minWidth={206} onClose={onClose}>
      {entries.map((m, i) => m.verb === "hr"
        ? <div key={i} className="dk-hr" />
        : <Item key={m.verb} icon={ICON_OF[m.verb]} label={m.label} disabled={m.disabled} reason={m.reason} danger={m.danger}
          onClick={() => { onClose(); onPick(m.verb); }} />)}
    </AnchoredMenu>
  );
}

export async function copyTo(text: string, what: string, flash: (ok: boolean, msg: string) => void): Promise<void> {
  try { await navigator.clipboard.writeText(text); flash(true, `Copied ${what}`); }
  catch { flash(false, "Could not reach the clipboard"); }
}

/* ---- the two-step confirm, inside the card it belongs to ---- */
export function ConfirmBar({ children, yes, onYes, onNo }: { children: ReactNode; yes: string; onYes: () => void; onNo: () => void }) {
  useEscapeClose(onNo);
  return (
    <div className="dk-confirm" role="alertdialog" data-danger>
      <span>{children}</span>
      <Button size="compact" tone="danger" autoFocus onClick={onYes}>{yes}</Button>
      <Button size="compact" tone="quiet" onClick={onNo}>Cancel</Button>
    </div>
  );
}

/* ---- the sentence, the cards, the group headings ---- */
export function Sentence({ lead, rest }: { lead: string; rest: string }) {
  return <p className="dk-say"><b>{lead}</b> {rest}</p>;
}

const CARD_ICON: Record<CardIcon, ReactNode> = {
  check: <DoneIcon size={ICON.lg} />, moon: <MinusCircleIcon size={ICON.lg} />, broom: <BroomIcon size={ICON.lg} />, lock: <LockIcon size={ICON.lg} />,
};

export function Answers<K extends string>({ cards, active, onPick, what }: { cards: AnswerSpec<K>[]; active: K | null; onPick: (k: K) => void; what: string }) {
  return (
    <div className="dk-answers">
      {cards.map((c) => (
        <AnswerCard<K> key={c.id} id={c.id} tone={c.tone} icon={CARD_ICON[c.icon]} n={c.n} word={c.word} detail={c.detail} now={c.now}
          active={active} onPick={onPick} what={what} />
      ))}
    </div>
  );
}

export function GroupHead({ title, sub }: { title: string; sub: string }) {
  return <div className="dk-xg"><span>{title}</span><span className="t">{sub}</span></div>;
}

export function ReadOnlyNote({ on }: { on: boolean }) {
  return on ? <span className="dk-xe" style={{ display: "block", marginTop: 10 }}>This instance is read-only, so the remove buttons are off.</span> : null;
}

/* ---- the pictures a list has besides cards ---- */
export function ResourceSkeleton({ what }: { what: string }) {
  return (
    <div className="dk-xs" aria-busy="true" aria-label={`Loading ${what}`}>
      <i className="dk-sk" style={{ width: "46%", height: 16, marginBottom: 14 }} />
      <div className="dk-answers">
        {[0, 1, 2].map((i) => (
          <div key={i} className="dk-ans" style={{ ...tint("var(--text4)"), "--tone": "var(--text4)", cursor: "default" } as CSSProperties}>
            <div className="dk-tile" />
            <div className="dk-shim" style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}><i style={{ width: "40%" }} /><i style={{ width: "80%" }} /></div>
          </div>
        ))}
      </div>
      <div className="dk-xgrid">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="dk-xk">
            <div className="dk-xt"><span className="dk-g" /><div className="dk-shim"><i style={{ width: "50%" }} /></div><span /><span /></div>
            <div className="dk-xb"><div className="dk-shim"><i /></div></div>
            <div className="dk-xf"><div className="dk-shim" style={{ flex: 1 }}><i style={{ width: "60%" }} /></div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ResourceError({ what, cmd, error, onTry }: { what: string; cmd: string; error?: string; onTry: () => void }) {
  return (
    <div className="dk-xs" role="alert">
      <div className="dk-hnote">
        <WarningIcon size={ICON.md} />
        <div><b>Could not read the {what}.</b><br />docker {cmd}: {error || "Cannot connect to the Docker daemon."}</div>
      </div>
      <div style={{ marginTop: 10 }}><Button onClick={onTry}><RefreshIcon size={ICON.sm} />Try again</Button></div>
    </div>
  );
}

export function ResourceEmpty({ title, text, icon = <CubeIcon size={ICON.xl} /> }: { title: string; text: string; icon?: ReactNode }) {
  return (
    <div className="dk-full">
      <div className="dk-card" style={tint("var(--info)")}>
        <span className="ico">{icon}</span>
        <b>{title}</b>
        <p>{text}</p>
      </div>
    </div>
  );
}

export function NoMatch({ q, filtered, onClear }: { q: string; filtered: boolean; onClear: () => void }) {
  return (
    <div className="dk-empty-s">
      {filtered && !q.trim() ? "Nothing in this group." : `Nothing matches “${q}”.`}{" "}
      <Button size="compact" onClick={onClear}>{q.trim() ? "Clear the filter" : "Show everything"}</Button>
    </div>
  );
}
