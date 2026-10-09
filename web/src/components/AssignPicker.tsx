import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { PeoplePick } from "./PeoplePick.tsx";
import { CaretIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import type { ListMember, StepAssign } from "../../../shared/providers.ts";
import type { Ensure, PrAuthor } from "../lib/stepAssign.ts";
import { askModel, filterAsk, pickName, pickToEnsure, startingPick, type AskModel, type Picked } from "../lib/askAtRun.ts";

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
  /** Said once when the setting could not be honoured (an author who maps to nobody). */
  note?: string;
  /** The members are known (or could not be read): the picker is not guessing any more. */
  ready: boolean;
}

export function useAskAssign(o: {
  on: boolean;
  listId?: string;
  start?: StepAssign;
  author?: PrAuthor | null;
  onCard?: readonly { id?: number | null }[];
  /** For a caller that already holds the members: no read at all. */
  members?: ListMember[] | null;
}): AskAssign {
  const [read, setRead] = useState<ListMember[] | null | "none">(null);
  useEffect(() => {
    if (!o.on || o.members !== undefined || !o.listId) return;
    let live = true;
    void api.clickupMembers(o.listId).then((r) => { if (live) setRead(r?.ok ? (r.members ?? []) : "none"); }).catch(() => { if (live) setRead("none"); });
    return () => { live = false; };
  }, [o.on, o.listId, o.members]);
  const members = o.members !== undefined ? o.members : read === "none" ? [] : read;
  const ready = !o.on || members !== null;
  const startKey = JSON.stringify([o.start ?? null, o.author?.login ?? null, members?.length ?? -1]);
  const begin = useMemo(() => startingPick(o.start, { members, author: o.author }), [startKey]);
  const [chosen, setChosen] = useState<Picked | null>(null);
  const pick = chosen ?? begin.pick;
  const model = useMemo(() => askModel({ members, author: o.author, onCard: o.onCard }), [members, o.author?.login, JSON.stringify(o.onCard ?? [])]);
  return { model, members, pick, setPick: setChosen, ensure: pickToEnsure(pick), ...(chosen ? null : begin.note ? { note: begin.note } : null), ready };
}

export function Face({ m }: { m: Pick<ListMember, "avatar" | "color" | "initials"> }) {
  return m.avatar
    ? <img src={m.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
    : <span className="shrink-0 rounded-full inline-flex items-center justify-center" style={{ width: 16, height: 16, background: m.color || "var(--bg4)", color: "#fff", fontSize: 8 }}>{m.initials}</span>;
}

/**
 * The picker: a button that says who, and the app's one people picker under it (components/PeoplePick:
 * the same list, filter box and clamp the card's "Assigned" select uses), with the suggestions first
 * and "Nobody" as its own choice below the list.
 */
export function AssignPicker({ state, disabled, label = "Assign to" }: { state: AskAssign; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { model, pick, setPick } = state;
  const who = pick.kind === "person" ? state.members?.find((m) => m.id === pick.id) : undefined;
  const tags = new Map(model.rows.map((r) => [r.member.id, r.tags] as const));
  const close = () => { setOpen(false); btn.current?.focus(); };
  return (
    <span className="inline-flex flex-col gap-1 items-start" data-assign-picker="">
      <button ref={btn} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${pickName(pick)}`} title={`${label}: ${pickName(pick)}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 text-[11px] px-2 py-1 rounded disabled:opacity-50" style={{ border: EDGE, color: "var(--text)", background: "var(--bg)" }}>
        {who ? <Face m={who} /> : null}
        <span className="truncate max-w-[200px]">{pickName(pick)}</span>
        <CaretIcon size={ICON.xs} />
      </button>
      {state.note && <span className="text-[10px]" role="status" style={{ color: "var(--warning-ink)" }}>{state.note}</span>}
      {model.authorUnmapped && <span className="text-[10px]" style={{ color: "var(--text3)" }}>No member matches “{model.authorUnmapped}”, the pull request’s author.</span>}
      {open && (
        <PeoplePick anchor={btn} members={model.rows.map((r) => r.member)} busy={state.members === null} filterOver={8}
          isOn={(m) => pick.kind === "person" && pick.id === m.id}
          dividerBefore={(m, prev) => (tags.get(prev.id)?.length ?? 0) > 0 && (tags.get(m.id)?.length ?? 0) === 0}
          note={(m) => (tags.get(m.id) ?? []).filter((t) => t !== "you").join(" · ") || undefined}
          face={(m) => <Face m={m} />}
          onPick={(m) => { setPick({ kind: "person", id: m.id, name: m.name }); close(); }}
          onClose={close}
          footer={<button type="button" className="w-full text-left px-2 py-1.5 hover:bg-white/5 flex items-center gap-2 text-[11.5px]" style={{ color: pick.kind === "nobody" ? "var(--success)" : "var(--text2)" }}
            onClick={() => { setPick({ kind: "nobody" }); close(); }}>
            <span className="flex-1">Nobody</span><span className="text-[10px]" style={{ color: "var(--text3)" }}>leave the card’s people as they are</span>
            {pick.kind === "nobody" ? <DoneIcon size={ICON.xs} /> : null}
          </button>} />
      )}
    </span>
  );
}
