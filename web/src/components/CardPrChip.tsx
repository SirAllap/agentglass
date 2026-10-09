import { useState, type ReactNode } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { Avatar } from "./Avatar.tsx";
import { LinkIcon, PullRequestIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import {
  cardPrInk, cardPrTint, isRelated, mergedInk, relatedNote, restCounts, sortedCardPrs,
  type CardPr, type CardPrPick,
} from "../lib/cardPrPick.ts";

/**
 * The pull-request chip on a card's board row, and the popover behind it.
 *
 * A pull request cut for the card wears the state colours and the pull-request
 * glyph. One that only NAMES the card (a stacked pull request saying it depends
 * on the card below) wears the link glyph, the `--info` tint and a dashed edge,
 * so two cards never read as sharing a pull request. Ceiling: the difference is
 * glyph, tint and edge; the popover has no section headers.
 */
export function CardPrChip({ pick, onOpen }: { pick: CardPrPick; onOpen: (p: CardPr) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (pick.kind === "none") return null;
  const shown = pick.kind === "one" ? pick.pr : pick.primary;
  const restCount = pick.kind === "many" ? pick.rest.length : 0;
  /* The others, told apart: a pull request cut for this card and one that only
     names it are not the same "+1". When the chip itself is a mention,
     everything behind it is one more of the same. */
  const rc = pick.kind === "many" ? restCounts(pick.rest) : { own: 0, related: 0 };
  const relatedChip = isRelated(shown);
  const plusN = relatedChip ? restCount : rc.own;
  const plusRelated = relatedChip ? 0 : rc.related;
  const tint = cardPrTint(shown);
  const ink = cardPrInk(shown);
  const label = shown.draft ? "Draft" : shown.state === "MERGED" ? "Merged" : shown.state === "CLOSED" ? "Closed" : "Open";
  return (
    <>
      <button type="button"
        onClick={(e) => { e.stopPropagation(); if (pick.kind === "many") { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); } else { onOpen(shown); } }}
        className="agx-onrow inline-flex items-center gap-1 rounded-full shrink-0 whitespace-nowrap px-1.5 py-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
        style={{
          color: ink, background: `color-mix(in srgb, ${tint} 13%, transparent)`,
          border: `1px ${relatedChip ? "dashed" : "solid"} color-mix(in srgb, ${tint} 40%, transparent)`,
          outlineColor: tint,
        }}
        aria-label={relatedChip ? `${label} pull request #${shown.number}, ${relatedNote(shown)}` : undefined}
        title={`${relatedChip ? `${relatedNote(shown)} — ` : ""}${label} pull request #${shown.number}${shown.author ? (shown.mine ? ", yours" : ` by @${shown.author}`) : ""}${restCount ? ` (${plusN ? `+${plusN} more` : ""}${plusN && plusRelated ? ", " : ""}${plusRelated ? `${plusRelated} related, only names this card` : ""})` : ""} — ${shown.title}`}>
        {relatedChip ? <LinkIcon size={ICON.xs} /> : <PullRequestIcon size={ICON.xs} />}
        <span className="text-[10.5px] tabular-nums font-mono leading-none">#{shown.number}</span>
        {plusN > 0 && <span className="text-[9.5px] leading-none" style={{ opacity: 0.85 }}>+{plusN}</span>}
        {plusRelated > 0 && (
          <span className="inline-flex items-center gap-px text-[9.5px] leading-none" style={{ opacity: 0.85 }}>
            <LinkIcon size={ICON.xs} />{plusRelated}
          </span>
        )}
      </button>
      {menu && pick.kind === "many" && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {sortedCardPrs([pick.primary, ...pick.rest]).map((p) => (
            <MenuItem key={p.number} onClick={() => { setMenu(null); onOpen(p); }}>
              <span className="flex items-center gap-1.5 min-w-0 w-full"
                title={isRelated(p) ? relatedNote(p) : undefined}
                aria-label={isRelated(p) ? `#${p.number}, ${relatedNote(p)}` : undefined}>
                {isRelated(p)
                  ? <span className="shrink-0 inline-flex" style={{ color: cardPrInk(p) }}><LinkIcon size={ICON.xs} /></span>
                  : <span className="shrink-0" style={{ width: 7, height: 7, borderRadius: 999, background: cardPrTint(p) }} />}
                <span className="tabular-nums font-mono shrink-0">#{p.number}</span>
                <span className="truncate" style={{ color: isRelated(p) ? "var(--text4)" : "var(--text3)", fontStyle: isRelated(p) ? "italic" : undefined }}>{p.title}</span>
                {p.author && (
                  <span className="shrink-0 ml-auto pl-3 inline-flex"
                    title={p.mine ? `you (@${p.author})` : `@${p.author}`}
                    aria-label={p.mine ? `you, @${p.author}` : `@${p.author}`}>
                    <Avatar login={p.author} size={ICON.sm} />
                  </span>
                )}
              </span>
            </MenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  );
}

/** One row of the card's GitHub tab, pull request or other link: see TasksPanel. */
export const LINK_ROW = "flex items-start gap-2 py-1";

/** One pull request in the card pane's GitHub tab. A mention is marked with the
 *  link glyph and a line saying whose it is; the card's own look as before. */
export function CardPrDetailRow({ p, onOpen, trailing }: { p: CardPr & { stated?: boolean }; onOpen: () => void; trailing: ReactNode }) {
  const related = isRelated(p);
  return (
    <div className={LINK_ROW}>
      <button onClick={onOpen}
        className="text-left flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-white/5"
        aria-label={related ? `#${p.number}, ${relatedNote(p)}` : undefined}
        title={related ? `${relatedNote(p)}. Open this pull request` : "Open this pull request"}>
        {related && (
          <span className="inline-flex align-middle mr-1" style={{ color: "var(--info-ink)" }}><LinkIcon size={ICON.xs} /></span>
        )}
        <span className="tabular-nums" style={{ color: related ? "var(--info-ink)" : "var(--primary-ink)" }}>#{p.number}</span>
        {p.state && (
          <span className="ml-1.5 text-[10px] tracking-[0.06em] px-1.5 rounded"
            style={p.state === "MERGED"
              ? { color: mergedInk(), background: "#a371f721" }
              : p.state === "CLOSED"
              ? { color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }
              : { color: "var(--success-ink)", background: "color-mix(in srgb, var(--success) 13%, transparent)" }}>
            {p.draft ? "DRAFT" : p.state}
          </span>
        )}
        {p.stated && (
          <span className="ml-1.5 text-[10px]" style={{ color: "var(--text4)" }} title="named on the card itself">on the card</span>
        )}
        <div className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{p.title || p.url}</div>
        {related && (
          <div className="truncate text-[10px]" style={{ color: "var(--info-ink)" }}>{relatedNote(p)}</div>
        )}
      </button>
      {trailing}
    </div>
  );
}
