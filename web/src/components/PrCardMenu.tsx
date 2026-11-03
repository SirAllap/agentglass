/*
 * The pull-request card's right-click menu, drawn from the model in
 * lib/prCardMenu.ts. What is offered, what is off and why, and how many entries
 * sit behind "More" are decided there; this file draws them and walks them.
 *
 * The header stays put and the list scrolls inside the rounded box, capped at
 * min(560px, 100vh - 32px). The native bar is hidden and a themed one is drawn
 * (8px track, a thumb you can drag), with a soft fade at the edge that has more
 * to show; the arithmetic is lib/scrollThumb.ts.
 *
 * Keys: the arrows wrap, Home and End jump, Enter and Space press, Escape
 * closes (the shared ContextMenu owns that one). An entry that is off stays in
 * the list with its reason underneath and is skipped by the arrows, so the menu
 * keeps its shape from one card to the next.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "./ContextMenu.tsx";
import { ICON } from "../lib/iconSize.ts";
import {
  ArrowIcon, BoltIcon, BranchIcon, CaretIcon, CommentIcon, CopyIcon, CrossIcon, EditIcon, ExpandIcon, EyeOffIcon, HandIcon, LinkIcon,
  ListIcon, MergeIcon, PinIcon, PullRequestIcon, RefreshIcon, SparkleIcon, TagIcon, TerminalIcon, UserIcon, WarningIcon,
} from "../lib/glyphIcons.tsx";
import { BellIcon } from "./settingsNavIcons.tsx";
import { scrollForPress, thumbFor, TRACK_INSET, type Thumb } from "../lib/scrollThumb.ts";
import { walkIds, type CardMenu, type CardMenuId, type MenuIcon, type MenuItem } from "../lib/prCardMenu.ts";
import { BoxIcon, EyeIcon, LayersIcon } from "../lib/glyphIcons.tsx";

export const MENU_WIDTH = 268;

const glyph = (i: MenuIcon): ReactNode => {
  const s = ICON.sm;
  switch (i) {
    case "hand": return <HandIcon size={s} />;
    case "user": return <UserIcon size={s} />;
    case "spark": return <SparkleIcon size={s} />;
    case "link": return <LinkIcon size={s} />;
    case "down": return <CaretIcon size={s} />;
    case "alert": return <WarningIcon size={s} />;
    case "refresh": return <RefreshIcon size={s} />;
    case "bell": return <BellIcon size={s} />;
    case "merge": return <MergeIcon size={s} />;
    case "ext": return <ArrowIcon size={s} />;
    case "pin": return <PinIcon size={s} />;
    case "pr": return <PullRequestIcon size={s} />;
    case "max": return <ExpandIcon size={s} />;
    case "copy": return <CopyIcon size={s} />;
    case "branch": return <BranchIcon size={s} />;
    case "term": return <TerminalIcon size={s} />;
    case "edit": return <EditIcon size={s} />;
    case "eye": return <EyeOffIcon size={s} />;
    case "x": return <CrossIcon size={s} />;
    case "plug": return <BoltIcon size={s} />;
    case "megaphone": return <CommentIcon size={s} />;
    case "tag": return <TagIcon size={s} />;
    case "lines": return <ListIcon size={s} />;
    case "sparkles": return <SparkleIcon size={s} />;
    case "box": return <BoxIcon size={s} />;
    case "layers": return <LayersIcon size={s} />;
    case "eyeon": return <EyeIcon size={s} />;
  }
};

export function PrCardMenu<I extends string = CardMenuId>({ menu, x, y, onPick, onClose }: {
  menu: CardMenu<I>; x: number; y: number;
  onPick: (id: I) => void; onClose: () => void;
}) {
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [drag, setDrag] = useState(false);
  const measure = useCallback(() => {
    const sc = scroller.current;
    if (sc) setThumb(thumbFor(sc.scrollTop, sc.clientHeight, sc.scrollHeight));
  }, []);
  /* The list grows when "More" opens, and the box is capped: measure after both. */
  useLayoutEffect(measure, [more, measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  const dragTrack = (e: React.PointerEvent<HTMLElement>, onThumb: boolean) => {
    const sc = scroller.current;
    const track = e.currentTarget.closest<HTMLElement>("[data-sbt]");
    if (!sc || !track || !thumb) return;
    e.preventDefault();
    e.stopPropagation();
    const r = track.getBoundingClientRect();
    if (!onThumb) sc.scrollTop = scrollForPress(e.clientY - r.top, thumb.height, thumb.track, sc.clientHeight, sc.scrollHeight);
    const y0 = e.clientY, s0 = sc.scrollTop;
    const span = sc.scrollHeight - sc.clientHeight, room = thumb.track - thumb.height;
    setDrag(true);
    const mv = (ev: PointerEvent) => { sc.scrollTop = s0 + ((ev.clientY - y0) / room) * span; };
    const up = () => { setDrag(false); window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const focusId = (id: string) => root.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`)?.focus();

  /* The first entry that is on takes focus, so the keyboard is in the menu the
     moment it opens. */
  useEffect(() => { const first = walkIds(menu, false)[0]; if (first) focusId(first); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    const order = walkIds(menu, more);
    const at = order.indexOf((document.activeElement as HTMLElement | null)?.dataset.mid as never);
    let to = -1;
    if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % order.length;
    else if (e.key === "ArrowUp") to = at < 0 ? order.length - 1 : (at - 1 + order.length) % order.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = order.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    focusId(order[to]!);
  };

  const press = (it: MenuItem<I>) => {
    if (it.why) return;
    onPick(it.id);
    onClose();
  };
  const row = (it: MenuItem<I>) => (
    <button key={it.id} role="menuitem" data-mid={it.id} tabIndex={-1}
      aria-disabled={it.why ? true : undefined}
      onClick={() => press(it)}
      className="agx-pcm-item"
      data-strong={it.strong ? "1" : undefined} data-danger={it.danger ? "1" : undefined}>
      <span aria-hidden className="agx-pcm-ico">{glyph(it.icon)}</span>
      <span className="agx-pcm-txt">
        <span className="agx-pcm-lbl">{it.label}</span>
        {(it.why || it.sub) && <span className="agx-pcm-sub">{it.why ?? it.sub}</span>}
      </span>
      {it.hint && <span aria-hidden className="agx-pcm-key">{it.hint}</span>}
    </button>
  );

  return (
    <ContextMenu pop x={x} y={y} onClose={onClose} width={MENU_WIDTH} label={menu.head}>
      <div ref={root} onKeyDown={onKey} className="agx-pcm" data-more-t={thumb?.more.above ? "1" : undefined} data-more-b={thumb?.more.below ? "1" : undefined}>
        <div className="agx-pcm-head" data-tip={menu.head}>{menu.head}</div>
        <div ref={scroller} onScroll={measure} className="agx-pcm-scroll">
          {menu.rows.map((r, i) =>
            r.kind === "rule" ? <div key={i} role="separator" className="agx-pcm-rule" />
              : r.kind === "heading" ? <div key={i} role="presentation" className="agx-pcm-h">{r.text}</div>
              : row(r))}
          {menu.more.length > 0 && (
            <button role="menuitem" data-mid="more" tabIndex={-1} aria-expanded={more} onClick={() => setMore((m) => !m)}
              className="agx-pcm-item" data-more="1">
              <span aria-hidden className="agx-pcm-ico"><CaretIcon size={ICON.sm} className={more ? "rotate-90" : "-rotate-90"} /></span>
              <span className="agx-pcm-txt"><span className="agx-pcm-lbl">{more ? "Fewer" : "More"}</span></span>
              {!more && <span aria-hidden className="agx-pcm-key">{menu.more.length} more</span>}
            </button>
          )}
          {more && <div className="agx-pcm-more">{menu.more.map(row)}</div>}
          {!menu.closeAbsent && (
            <>
              <div role="separator" className="agx-pcm-rule" />
              {row(menu.close)}
            </>
          )}
        </div>
        {thumb?.over && (
          <i aria-hidden data-sbt="1" className="agx-pcm-sbt" style={{ top: (scroller.current?.offsetTop ?? 0) + TRACK_INSET, height: thumb.track }}
            onPointerDown={(e) => dragTrack(e, false)}>
            <i className="agx-pcm-sbh" data-drag={drag ? "1" : undefined} style={{ height: thumb.height, top: thumb.top }}
              onPointerDown={(e) => dragTrack(e, true)} />
          </i>
        )}
      </div>
    </ContextMenu>
  );
}
