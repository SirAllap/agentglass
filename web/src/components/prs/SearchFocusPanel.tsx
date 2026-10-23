import { Avatar } from "../Avatar.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { PinIcon } from "../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import { focusItems, type SearchFocus } from "../../lib/useSearchFocus.ts";
import { BAR_CTRL, BAR_ICON, EDGE } from "../workspace/Chrome.tsx";

const LABEL = "px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide";

/**
 * What the search box offers while it has focus and nothing is typed: the
 * people followed, the pinned searches, the recent ones. A menu — Up and Down
 * walk it, and the box keeps focus, so every row acts on mouse-down. It draws
 * from `focus` and asks nobody for anything; choosing a row is one Enter.
 */
export function SearchFocusPanel({ focus, cursor }: { focus: SearchFocus; cursor: number }) {
  const items = focusItems(focus);
  const at = (kind: string, value: string) => {
    const i = items.findIndex((x) => x.kind === kind && x.value === value);
    return i >= 0 && i === cursor;
  };
  const lit = (on: boolean) => (on ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)" } : undefined);
  const tap = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn(); };
  const people = [...focus.followed, ...focus.suggested];

  /* One row: the search runs from the left part; pin and remove are their own
     buttons, each HIT wide, so the row never changes width as they show. */
  const searchRow = (kind: "saved" | "recent", q: string, n: number | undefined, remove: boolean) => (
    <div key={`${kind}:${q}`} role="option" aria-selected={at(kind, q)} className="agx-mi flex items-center gap-1 pl-2.5 pr-1" style={lit(at(kind, q))}>
      <button onMouseDown={tap(() => focus.run(q))} className="flex-1 min-w-0 flex items-center gap-2 text-left text-[11px] py-1.5"
        style={{ color: "var(--text2)" }} title={`Search ${q}`}>
        <span className="truncate">{q}</span>
        {n !== undefined && <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--text4)" }}>{n}</span>}
      </button>
      <button onMouseDown={tap(() => focus.pin(q))} aria-pressed={focus.isPinned(q)} aria-label={focus.isPinned(q) ? "Unpin this search" : "Pin this search"}
        title={focus.isPinned(q) ? "Unpin" : "Pin"} className="agx-btn grid place-items-center rounded-md shrink-0"
        style={{ width: HIT, height: HIT, color: focus.isPinned(q) ? "var(--primary-ink)" : "var(--text3)" }}>
        <PinIcon size={BAR_ICON} filled={focus.isPinned(q)} />
      </button>
      {!remove && <span aria-hidden className="shrink-0" style={{ width: HIT }} />}
      {remove && (
        <button onMouseDown={tap(() => focus.remove(q))} aria-label="Remove from recent" title="Remove from recent"
          className="agx-btn grid place-items-center rounded-md shrink-0" style={{ width: HIT, height: HIT, color: "var(--text3)" }}>
          <CloseIcon size={BAR_ICON} />
        </button>
      )}
    </div>
  );

  return (
    <div id="pr-search-focus" role="listbox" aria-label="Recent and saved searches"
      className="absolute left-0 right-0 top-full mt-1 rounded-lg overflow-y-auto agx-scroll pb-1"
      style={{ zIndex: LAYER.menu, maxHeight: 360, border: EDGE, background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)" }}>
      {people.length > 0 && (
        <>
          <div className={LABEL} style={{ color: "var(--text4)" }}>{focus.followed.length ? "People" : "People · you open most"}</div>
          <div className="flex flex-wrap gap-1 px-2 pb-1">
            {people.map((login) => (
              <button key={login} role="option" aria-selected={at("person", login)} onMouseDown={tap(() => focus.openPerson(login))}
                title={`Open ${login}'s board`} className={`${BAR_CTRL} max-w-full`}
                style={{ color: "var(--text2)", ...lit(at("person", login)) }}>
                <Avatar login={login} size={ICON.md} />
                <span className="truncate">{login}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {focus.saved.length > 0 && (
        <>
          <div className={LABEL} style={{ color: "var(--text4)" }}>Saved</div>
          {focus.saved.map((s) => searchRow("saved", s.q, s.n, false))}
        </>
      )}
      {focus.recent.length > 0 && (
        <>
          <div className={`${LABEL} flex items-center`} style={{ color: "var(--text4)" }}>
            <span>Recent</span>
            <button onMouseDown={tap(focus.clearRecent)} className="agx-btn ml-auto normal-case tracking-normal rounded-md px-1.5 text-[10px]"
              style={{ color: "var(--text3)", height: HIT - 6 }}>Clear recent</button>
          </div>
          {focus.recent.map((r) => searchRow("recent", r.q, r.n, true))}
        </>
      )}
    </div>
  );
}
