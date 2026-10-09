import { useEffect, useMemo, useRef, useState } from "react";
import { listMembers } from "../lib/listMembers.ts";
import { PeoplePick } from "./PeoplePick.tsx";
import { CaretIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { AUTHOR_IS_MEMBER, type ListMember } from "../../../shared/providers.ts";
import type { Ensure, PrAuthor } from "../lib/stepAssign.ts";
import { askModel, isPicked, pickName, pickSentence, pickedIds, pickToEnsure, startingPick, startingTakeOff, togglePick, type AskModel, type Picked } from "../lib/askAtRun.ts";

/**
 * Who a block that asks when it runs puts on the card, chosen where the card is being acted on.
 *
 * The state is one hook so the three places that ask (the merge dialog, the card's button, the review
 * menu) behave the same: the members are read once for the card's list (the server holds them, so a
 * warm list costs no request), the picker starts where the setting says, and the first thing the
 * person does with it is theirs: a late answer from the server never moves a choice they have made.
 */
export interface AskAssign {
  model: AskModel;
  members: ListMember[] | null;
  pick: Picked;
  setPick: (p: Picked) => void;
  /** The same choice as the write understands it. */
  ensure: Ensure;
  /** The members are known (or could not be read): the picker is not guessing any more. */
  ready: boolean;
}

export function useAskAssign(o: {
  on: boolean;
  listId?: string;
  start?: Parameters<typeof startingPick>[0];
  /** Only used where the tracker's accounts are GitHub's (AUTHOR_IS_MEMBER); for ClickUp it is ignored. */
  author?: PrAuthor | null;
  onCard?: readonly { id?: number | null }[];
  /** For a caller that already holds the members: no read at all. */
  members?: ListMember[] | null;
}): AskAssign {
  const [read, setRead] = useState<ListMember[] | null | "none">(null);
  useEffect(() => {
    if (!o.on || o.members !== undefined || !o.listId) return;
    let live = true;
    void listMembers(o.listId).then((r) => { if (live) setRead(r?.ok ? (r.members ?? []) : "none"); }).catch(() => { if (live) setRead("none"); });
    return () => { live = false; };
  }, [o.on, o.listId, o.members]);
  const members = o.members !== undefined ? o.members : read === "none" ? [] : read;
  const ready = !o.on || members !== null;
  const author = o.author;
  const authorIsMember = AUTHOR_IS_MEMBER.clickup === true;
  const startKey = JSON.stringify([o.start ?? null, author?.login ?? null, members?.length ?? -1]);
  const begin = useMemo(() => startingPick(o.start, { members, author, authorIsMember }), [startKey]);
  const [chosen, setChosen] = useState<Picked | null>(null);
  const pick = chosen ?? begin.pick;
  const model = useMemo(() => askModel({ members, author, authorIsMember, onCard: o.onCard }), [members, author?.login, JSON.stringify(o.onCard ?? [])]);
  return { model, members, pick, setPick: setChosen, ensure: pickToEnsure(pick), ready };
}

export function Face({ m }: { m: { avatar?: string; color?: string; initials?: string } }) {
  return m.avatar
    ? <img src={m.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
    : <span className="shrink-0 rounded-full inline-flex items-center justify-center" style={{ width: 16, height: 16, background: m.color || "var(--bg4)", color: "#fff", fontSize: 8 }}>{m.initials}</span>;
}

/**
 * The take-off's question: who comes off the card, among the people on it. Same shape as the assign hook, over
 * the card's own people (nothing to read).
 */
export function useAskTakeOff(o: { on: boolean; cardPeople: readonly ListMember[]; start?: Parameters<typeof startingTakeOff>[0] }): AskAssign & { ids: number[] } {
  const key = JSON.stringify([o.start ?? null, o.cardPeople.map((m) => m.id)]);
  const begin = useMemo(() => startingTakeOff(o.start, { cardPeople: o.cardPeople }), [key]);
  const [chosen, setChosen] = useState<Picked | null>(null);
  const pick = chosen ?? begin;
  const members = [...o.cardPeople];
  const model = useMemo(() => askModel({ members, onCard: members }), [key]);
  return { model, members, pick, setPick: setChosen, ensure: pickToEnsure(pick), ready: true, ids: pickedIds(pick, members) };
}

/**
 * The picker: a button that says who (their faces, stacked, and their names), and the app's one people picker
 * under it (components/PeoplePick, as the card's "Assigned" select draws it: filter box, ticks, stays open, the card's
 * people first, then you, a rule, then everyone). A tick adds a person or takes them off the choice; "Nobody" clears it.
 */
export function AssignPicker({ state, disabled, label = "Assign to", nobody = "leave the card’s people as they are" }: { state: AskAssign; disabled?: boolean; label?: string; nobody?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { model, pick, setPick } = state;
  const faces = pick.slice(0, 3).map((x) => (x.kind === "me" ? state.members?.find((m) => m.me) : state.members?.find((m) => m.id === x.id)));
  const onCard = new Set(model.rows.filter((r) => r.onCard).map((r) => r.member.id));
  const close = () => { setOpen(false); btn.current?.focus(); };
  return (
    <span className="inline-flex flex-col gap-1 items-start" data-assign-picker="">
      <button ref={btn} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${pickName(pick)}`} title={`${label}: ${pickSentence(pick)}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 text-[11px] px-2 py-1 rounded disabled:opacity-50" style={{ border: EDGE, color: "var(--text)", background: "var(--bg)" }}>
        {faces.some(Boolean) && <span className="inline-flex items-center">{faces.map((m, i) => m && <span key={m.id} className="inline-flex rounded-full" style={{ marginLeft: i ? -4 : 0, boxShadow: "0 0 0 1.5px var(--bg)" }}><Face m={m} /></span>)}</span>}
        <span className="truncate max-w-[220px]">{pickName(pick)}</span>
        <CaretIcon size={ICON.xs} />
      </button>
      {open && (
        <PeoplePick anchor={btn} members={model.rows.map((r) => r.member)} busy={state.members === null} filterOver={12}
          isOn={(m) => isPicked(pick, m)}
          dividerBefore={(m, prev) => onCard.has(m.id) !== onCard.has(prev.id)}
          face={(m) => <Face m={m} />}
          onPick={(m) => setPick(togglePick(pick, m))}
          onClose={close}
          footer={<button type="button" className="w-full text-left px-2 py-1.5 hover:bg-white/5 flex items-center gap-2 text-[11.5px]" style={{ color: pick.length === 0 ? "var(--success)" : "var(--text2)" }}
            onClick={() => { setPick([]); close(); }}>
            <span className="flex-1">Nobody</span><span className="text-[10px]" style={{ color: "var(--text3)" }}>{nobody}</span>
            {pick.length === 0 ? <DoneIcon size={ICON.xs} /> : null}
          </button>} />
      )}
    </span>
  );
}
