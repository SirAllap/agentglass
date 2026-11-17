import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Portal } from "./Portal.tsx";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { usePopoverKeys } from "../lib/focusTrap.ts";
import { menuUnder, PICK_W, PICK_H } from "../lib/menuPos.ts";
import { placeInBox } from "../lib/pickerBox.ts";
import type { ListMember } from "../../../shared/providers.ts";
import { PickerCard, type PickerItem } from "./PickerCard.tsx";
import { dedupePeople, subline, type PersonSource } from "../lib/personRow.ts";

/*
 * The picker this app uses to put somebody on a card.
 *
 * There was one, in the card view, and it had already learned everything worth
 * knowing: 527 names on a real workspace, so a filter box rather than a scroll;
 * a Portal and a clamp, because a popover anchored inside content that scrolls
 * gets clipped by something eventually ("ilter people…", cut down the middle);
 * and it STAYS OPEN, because putting two people on and taking yourself off is
 * one thought rather than three trips through a list of five hundred.
 *
 * Then a second one appeared beside the pull request, drawn as a plain dropdown
 * of names — it ran off the bottom-right of the window and looked nothing like
 * the first. "That selection modal opens outside the window, and it does not
 * follow the standard, which should be this one." So this is that first one, lifted out, and both places
 * draw it.
 *
 * Presentational only: the caller says who is on, who is saving and what a
 * press means. The card view keeps its optimistic writes; the pull request
 * sends one write per press.
 */

export interface PeoplePickProps {
  /** The control this hangs under. Measured on open and clamped to the window. */
  anchor: RefObject<HTMLElement | null>;
  /** In the order they should be read — the caller decides who comes first. */
  members: ListMember[] | null;
  busy?: boolean;
  isOn: (m: ListMember) => boolean;
  isSaving?: (m: ListMember) => boolean;
  /** A rule between two groups — "everybody above works this board". */
  dividerBefore?: (m: ListMember, prev: ListMember) => boolean;
  onPick: (m: ListMember) => void;
  onClose: () => void;
  /** Drawn for each row: the app's own face, whichever component that is where
   *  this is used. */
  face: (m: ListMember) => ReactNode;
  /** A heading to draw before this row, when it opens a group ("Suggested", "Everyone"). */
  groupBefore?: (m: ListMember, prev: ListMember | undefined) => string | undefined;
  /** A row that cannot be changed from here, and why (the person is put on by another setting): drawn as it is, disabled. */
  locked?: (m: ListMember) => string | undefined;
  /** A few words after a name, for why somebody is up the list ("pull request author · on the card"). */
  note?: (m: ListMember) => string | undefined;
  /** The line under a name, when the caller has its own to say (a reason, not an email). */
  sub?: (m: ListMember) => string | undefined;
  /** A name for the popover, for a caller that draws it as a question ("Give the card to"). */
  label?: string;
  /** Which side to open on when there is room: above is for a trigger that sits over something that must stay visible. */
  prefer?: "below" | "above";
  /** After the list, outside the scroll: a choice that is not a person ("Nobody"). */
  footer?: ReactNode;
  /** Below this many names the filter box is noise. */
  filterOver?: number;
  empty?: string;
  /** The ask failed: said in the card, instead of the empty line. */
  error?: string | null;
  /** The people are asked of the tracker by what is typed (it has no roster to
   *  hand over): the box is always there, its text goes to the caller, and the
   *  rows are drawn as given, not filtered here. */
  onQuery?: (q: string) => void;
  /** Which system the names came from, for the line under a name with no email. */
  source?: PersonSource;
}

export function PeoplePick(p: PeoplePickProps) {
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number }>({ top: 0, left: 0, maxHeight: PICK_H });
  const box = useRef<HTMLDivElement>(null);
  useCloseWithOwner(p.onClose, { from: p.anchor });
  usePopoverKeys(box, p.onClose);
  /* Measured on open AND when the window changes size: a position taken once is
     the one a resized window keeps, and it left the box hanging off the bottom
     right edge with its last rows out of reach. */
  useLayoutEffect(() => {
    const place = () => {
      const el = p.anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (p.prefer === "above") {
        const at = placeInBox(r, { width: PICK_W, height: PICK_H }, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, undefined, undefined, "above");
        setPos({ top: at.top, left: at.left, maxHeight: Math.min(PICK_H, at.maxHeight) });
      } else {
        setPos({ ...menuUnder(r, window.innerWidth, window.innerHeight), maxHeight: Math.min(PICK_H, window.innerHeight - 16) });
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [p.anchor, p.prefer]);

  const all = dedupePeople(p.members ?? [], (m) => `id:${String(m.id)}`);
  // Rows → the one card's rows. The caller's order stands (keep): the card's own
  // people first, and ticking never moves a row. A heading or a rule between two
  // groups becomes a group; the first segment, when it has no heading, sits loose.
  const byId = new Map(all.map((m) => [String(m.id), m]));
  const items = (() => {
    let group: string | undefined;
    return all.map((m, i): PickerItem => {
      const prev = all[i - 1];
      const heading = p.groupBefore?.(m, prev);
      if (heading) group = heading;
      else if (i > 0 && p.dividerBefore?.(m, prev!)) group = "Everyone";
      const saving = p.isSaving?.(m) ?? false;
      const lock = p.locked?.(m);
      const note = p.note?.(m);
      return {
        id: String(m.id), label: m.name, ...(group ? { group } : null),
        sub: (p.sub ? p.sub(m) : subline({ email: m.email, source: p.source, sub: m.me ? "you" : undefined })) || undefined,
        leading: p.face(m), on: p.isOn(m), disabled: saving || !!lock, title: lock ?? m.name,
        ...(note ? { note } : null),
        trailing: <>
          {note && <span className="text-[10px]">{note}</span>}
          {saving && <span className="agx-spin" aria-label="Applying" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />}
        </>,
      };
    });
  })();

  return (
    <Portal>
      <div data-menu-layer className="fixed inset-0" style={{ zIndex: 9998 }} onClick={p.onClose} />
      <div ref={box} data-menu-layer data-people-pick role={p.label ? "dialog" : undefined} aria-label={p.label}
        style={{ display: "contents" }}>
        <PickerCard
          items={items} keep remote={!!p.onQuery} onQuery={p.onQuery}
          search={!!p.onQuery || (!p.busy && all.length > (p.filterOver ?? 12))}
          foldable={false} loading={p.busy} error={p.error ?? null}
          onPick={(id) => { const m = byId.get(id); if (m) p.onPick(m); }} onClose={p.onClose}
          placeholder={p.onQuery ? "Find somebody…" : "Filter people…"} noun="person" label={p.label ?? "Pick somebody"}
          emptyText={p.empty ?? "Nobody is a member of this list."}
          footer={p.footer ? <div className="w-full py-1">{p.footer}</div> : undefined}
          room={pos.maxHeight} width={PICK_W + 60} style={{ top: pos.top, left: pos.left }} />
      </div>
    </Portal>
  );
}
