/*
 * The Jira sidebar folded to its rail: one square per saved board, filter or query, and Looked up. A square says what it
 * is in its tooltip (name and count) and carries the count as a badge when one is known; a starred view shows what the server counted (a dash while it is asked, N+ when it stopped at its page). Resting the pointer on the rail opens the whole sidebar over
 * the board (TasksPanel), so the squares only need to be the way back to one place.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { countLabel, starredAt, type TreeView, type ViewCount } from "../../lib/jiraTree.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { InboxIcon } from "../../lib/glyphIcons.tsx";
import { tipAttr } from "../../lib/tip.ts";
import { gotoStep } from "./gotoKey.ts";
import { jiraViewActiveNow } from "../../lib/jiraQueryPalette.ts";

/** `count` is a number from the board in hand, or what the server counted for a starred view ("N+" when it stopped at its page). */
function Square({ name, count, on, onClick, children }: { name: string; count?: number | ViewCount | undefined; on: boolean; onClick: () => void; children: ReactNode }) {
  const label = typeof count === "number" ? String(count) : count === undefined ? "" : countLabel(count);
  const tip = label && label !== "–" ? `${name} (${label} ${label === "1" ? "card" : "cards"})` : name;
  return (
    <button type="button" onClick={onClick} aria-label={tip} aria-current={on || undefined} data-tip={tipAttr(tip)}
      className="agx-jr-sq" data-on={on ? "" : undefined} style={{ width: HIT, height: HIT }}>
      {children}
      {/* No badge and no corner glyph: a 26px square held a letter, a count and a kind mark on top of each other, and
          every way of fitting three things in it overlapped. One letter fits; the count is in the tooltip. */}
    </button>
  );
}

export function JiraFoldedRail({ views, counts, looked, lit, onView, onLooked }: {
  views: readonly TreeView[];
  /** What the server counted per starred view; the open board's own count in `views` wins. */
  counts?: Record<string, ViewCount>;
  looked: number;
  lit: string | null;
  onView: (id: string) => void;
  onLooked: () => void;
}) {
  /* The folded sidebar unmounts JiraTree, so `g` then 1-9 is listened for here too (same rule as the tree). */
  const goto = useRef({ at: 0, views, onView });
  goto.current.views = views; goto.current.onView = onView;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const step = gotoStep(e, goto.current.at, Date.now(), jiraViewActiveNow());
      goto.current.at = step.at;
      const v = step.digit ? starredAt(goto.current.views, step.digit) : null;
      if (v) { e.preventDefault(); e.stopPropagation(); goto.current.onView(v.id); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  return (
    <div className="agx-jr agx-scroll" role="list" aria-label="Boards and filters">
      {views.map((v) => (
        <Square key={v.id} name={v.label} count={v.count ?? counts?.[v.id]} on={lit === v.id} onClick={() => onView(v.id)}>
          {/* Every square carries its view's initial: three saved queries drawn with the same search glyph could not be told
              apart. A filter or query keeps its kind as a small mark in the corner. */}
          <span className="agx-jr-letter" aria-hidden>{(v.label.trim()[0] ?? "?").toUpperCase()}</span>
        </Square>
      ))}
      {looked > 0 && <Square name="Looked up" count={looked} on={false} onClick={onLooked}><InboxIcon size={ICON.sm} /></Square>}
    </div>
  );
}
