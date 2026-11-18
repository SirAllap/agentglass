import type { RefObject } from "react";
import { PeoplePick } from "../PeoplePick.tsx";
import { Face } from "../AssignPicker.tsx";
import { ListRow } from "../workspace/Chrome.tsx";
import { choiceOf, type AssignRow } from "../../lib/jiraStepPlan.ts";
import { DoneIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import type { ListMember } from "../../../../shared/providers.ts";

/*
 * The people a Jira step's question offers, in the app's one picker: a box to type
 * in, a list with a ceiling that scrolls inside it, and the suggested people first
 * under one heading with the reason they are up there.
 *
 * It opens ABOVE its trigger. The trigger is the "Give it to" row, and directly under
 * it is the question's own summary — the row that says what the choice will do, which
 * is what the person is reading while they choose. A box that hangs down from the row
 * covers exactly that.
 *
 * The rows are PeoplePick's, so the filter, Enter and Escape are the same here as in
 * every other place a Jira person is picked; this file only says what a row means.
 */

export function JiraPeoplePick({ anchor, rows, value, onPick, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  rows: readonly AssignRow[];
  /** The choice now: a person's value, null for nobody, undefined for "leave it as it is". */
  value: string | null | undefined;
  onPick: (value: string | null | undefined) => void;
  onClose: () => void;
}) {
  // PeoplePick draws ListMembers; the row's position is its handle back to the person.
  const members: ListMember[] = rows.map((r, i) => ({
    id: i, name: r.person.name, initials: r.person.initials,
    ...(r.person.avatar ? { avatar: r.person.avatar } : null),
    ...(r.person.color ? { color: r.person.color } : null),
  }));
  const rowOf = (m: ListMember) => rows[Number(m.id)];
  const tick = (on: boolean) => (on ? <span className="flex" style={{ color: "var(--success-ink)" }}><DoneIcon size={ICON.xs} /></span> : null);
  return (
    <PeoplePick anchor={anchor} members={members} prefer="above" filterOver={0} label="Give the card to"
      isOn={(m) => { const r = rowOf(m); return !!r && value === choiceOf(r.person); }}
      onPick={(m) => { const r = rowOf(m); if (r) onPick(choiceOf(r.person)); }}
      onClose={onClose}
      face={(m) => { const r = rowOf(m); return r ? <Face m={r.person} /> : null; }}
      sub={(m) => rowOf(m)?.why}
      groupBefore={(m) => rowOf(m)?.heading}
      empty="Nobody matches that."
      footer={
        <>
          <ListRow onClick={() => onPick(undefined)} current={value === undefined} sub="nothing happens here" trailing={tick(value === undefined)}>Leave as is</ListRow>
          <ListRow onClick={() => onPick(null)} current={value === null} sub="takes whoever is on the card off it" trailing={tick(value === null)}>Nobody</ListRow>
        </>
      } />
  );
}
