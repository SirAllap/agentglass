/**
 * THE TRACKER BLOCK, on a board card's identity line.
 *
 * It used to be a bar of its own — 42px over the whole card, with the pull
 * request hanging from it in a nested panel — and the pair came out at two
 * rows of chrome before a single fact about the pull request. It is one
 * 28px block on the line the card already has: the work item's mark, its id as
 * a button, its status, and who it is on.
 *
 * What is decided here is only how it is drawn. WHICH block a card gets
 * (a card, a loading shape, a bare id, a hint, nothing) is `trackerBlock` in
 * prCardBlock.ts, where a test can reach it.
 *
 * THE COPY BUTTONS take the faces' place on pointer-over or focus-within, in
 * the same box, so the block never changes width or height while you reach for
 * one. The faces are the least urgent fact in it. Where there is no hover (a
 * coarse pointer) the buttons take an inline slot of their own instead: a
 * control that only exists under a pointer does not exist there. See the
 * `.agx-trk` rules in index.css.
 */
import { useState } from "react";
import { ICON, HIT } from "../lib/iconSize.ts";
import { CopyIcon, DoneIcon, ListIcon } from "../lib/glyphIcons.tsx";
import { CardChip, CardFace, CHIP_H } from "../lib/priority.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { openCard } from "../lib/openCard.ts";
import { taskLinkTitle, type TaskLink } from "../lib/taskLink.ts";
import { peopleShown, readingAge, type TrackerBlock } from "../lib/prCardBlock.ts";
import type { PrSummary } from "../../../shared/types.ts";

/** How long "Copied" stays on a copy button. */
const COPIED_MS = 1500;


export function CardTracker({ block, card, task, prOpen }: {
  block: TrackerBlock;
  card: PrSummary["card"];
  task: TaskLink | null;
  /** The pull request is still open: a card marked done under it gets the amber dot. */
  prOpen: boolean;
}) {
  const [copied, setCopied] = useState<"id" | "name" | null>(null);
  if (block === "none") return null;
  const copy = (kind: "id" | "name", text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(kind);
    setTimeout(() => setCopied(null), COPIED_MS);
  };
  const quiet = block === "hint";
  return (
    <div className="agx-trk" data-quiet={quiet ? "1" : undefined} data-block={block}>
      {block === "card" && card && (() => {
        const id = card.customId ?? card.id;
        const who = card.people ?? [];
        const { faces, more } = peopleShown(who.length);
        const names = who.map((x) => x.name).join(", ");
        /* A card marked done under a pull request still open: the amber dot,
           with the reason in the tooltip. Not a warning colour on the status
           itself — that colour is the board's own and means something else. */
        const odd = card.statusKind === "done" && prOpen;
        /* SAID WITH ITS AGE, because the board it came from is refreshed when
           somebody opens the tasks view, not on a timer. Under an hour it reads
           as current; older, it dims and carries its age, so the screen never
           states as fact something it has not checked. */
        const { stale, said } = readingAge(card.at);
        return (
          <>
            <CardChip id={id} priority={card.priority} className="agx-trk-id"
              title={`Open ${id} in Tasks — ${card.status}${card.priority ? `, ${card.priority} priority` : ""}`}
              onOpen={() => openCard(card.customId || card.id, card.customId)} />
            {odd && (
              <span aria-hidden className="shrink-0 rounded-full"
                style={{ width: 5, height: 5, background: "var(--warning)" }}
                title={`The card says "${card.status}" while this pull request is still open`} />
            )}
            {/* Never shrinks, never truncates: the status is the one fact in
                the block somebody reads without opening anything. */}
            <span className="inline-flex items-center gap-1 shrink-0"
              title={`The card was in "${card.status}"${said ? ` when this board was read, ${said}` : ""}`}>
              <StatusPill status={card.status} color={card.statusColor} dim={stale} />
              {stale && <span style={{ color: "var(--text3)" }}>{said}</span>}
            </span>
            <span className="agx-trk-fz">
              {who.length > 0 && (
                <span className="agx-trk-faces" role="img" style={{ isolation: "isolate" }}
                  aria-label={`Card assigned to ${names}`} title={`Card assigned to ${names}`}>
                  {who.slice(0, faces).map((person, n) => (
                    <CardFace key={person.id ?? person.name} p={person} n={n} size={20} overlap={2} ring={1.5} />
                  ))}
                  {more > 0 && (
                    <span className="inline-flex items-center justify-center rounded-full tabular-nums"
                      style={{ marginLeft: -2, height: 20, minWidth: 20, padding: "0 4px", fontSize: 9.5,
                        background: "var(--bg4)", color: "var(--text2)", boxShadow: "0 0 0 1.5px var(--bg2)", position: "relative" }}>
                      +{more}
                    </span>
                  )}
                </span>
              )}
              <span className="agx-trk-ovl">
                <CopyButton kind="id" label="Copy card ID" done={`Copied ${id}`} copied={copied === "id"}
                  onCopy={() => copy("id", id)}><CopyIcon size={ICON.xs} /></CopyButton>
                {card.title && (
                  <CopyButton kind="name" label="Copy card name" done="Copied card name" copied={copied === "name"}
                    onCopy={() => copy("name", card.title)}><ListIcon size={ICON.xs} /></CopyButton>
                )}
              </span>
            </span>
          </>
        );
      })()}
      {block === "loading" && (
        /* Still reading: the shape the answer will have, so the block does not
           change while it lands. */
        <span aria-hidden className="flex items-center gap-1.5">
          <span className="rounded" style={{ width: 96, height: CHIP_H, background: "color-mix(in srgb, var(--text) 8%, transparent)" }} />
          <span className="rounded" style={{ width: 70, height: CHIP_H, background: "color-mix(in srgb, var(--text) 8%, transparent)" }} />
        </span>
      )}
      {block === "id" && task && (
        /* A branch that names a card the saved boards have never seen: the id
           is all there is, and it is still worth showing. */
        <>
          <CardChip id={task.label} priority={null} className="agx-trk-id" title={taskLinkTitle(task)}
            onOpen={() => openCard(task.query, task.label)} />
          <span>card not found on your boards</span>
        </>
      )}
      {quiet && <span>No card linked</span>}
    </div>
  );
}

/** One of the two copy buttons: the glyph, and a tooltip that says "Copied …" for a moment. */
function CopyButton({ kind, label, done, copied, onCopy, children }: {
  kind: "id" | "name"; label: string; done: string; copied: boolean; onCopy: () => void; children: React.ReactNode;
}) {
  return (
    /* `stopPropagation`: the card underneath opens on click, and this press
       means "give me the text", not "show me the page". */
    <button type="button" className="agx-trk-cp agx-btn" data-k={kind} data-copied={copied ? "1" : undefined}
      aria-live="polite" aria-label={copied ? done : label}
      style={{ width: HIT, height: HIT }}
      onClick={(e) => { e.stopPropagation(); onCopy(); }}>
      <span aria-hidden className="flex">{copied ? <DoneIcon size={ICON.xs} /> : children}</span>
      <span aria-hidden className="agx-trk-tip">{copied ? done : label}</span>
    </button>
  );
}
