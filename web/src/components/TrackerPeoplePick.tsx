import { useEffect, useRef, useState } from "react";
import { avatarSrc } from "../lib/avatarSrc.ts";
import { PeoplePick } from "./PeoplePick.tsx";
import { EDGE, ListRow } from "./workspace/Chrome.tsx";
import { putCard } from "../lib/prCardStore.ts";
import { chipInk } from "../lib/contrast.ts";
import { isOnCard, PEOPLE_WAIT_MS, type PeopleResult, type PersonOption } from "../lib/trackerPeople.ts";
import type { Tracker } from "../lib/trackerApi.ts";
import { tipAttr } from "../lib/tip.ts";
import type { ListMember, ProviderTask } from "../../../shared/providers.ts";

const FACE = { width: 18, height: 18, borderRadius: 999 } as const;

const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";

/** A face, or the initials when the picture is not there or is not allowed to load (the Jira tab's rule). */
export function Face({ m }: { m: { name: string; avatar?: string; initials?: string; color?: string } }) {
  const [broken, setBroken] = useState(false);
  return m.avatar && !broken
    ? <img src={avatarSrc(m.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 object-cover" style={FACE} />
    : <span className="shrink-0 inline-flex items-center justify-center text-[9px] font-medium"
      style={{ ...FACE, background: m.color || "var(--bg4)", color: chipInk(m.color) }}>{m.initials ?? initialsOf(m.name)}</span>;
}
const face = (m: { name: string; avatar?: string; initials?: string; color?: string }) => <Face key={m.avatar ?? m.name} m={m} />;

/**
 * The person on a card whose tracker has one assignee (Jira): pick somebody,
 * or nobody. The app's own picker (PeoplePick), asked of the site by what is
 * typed, after a short pause, since Jira hands over no roster. A pick replaces
 * whoever is on the card; pressing the one on it, or "Nobody", takes them off.
 *
 * Jira looks through part of its directory and filters that, so a short list
 * is never presented as everybody: the box always says to type more.
 * ClickUp's several-people picker is `CardPeoplePick`, and is not this.
 */
export function TrackerPeoplePick({ tracker, task, query, onSaid, onTask, bare }: {
  tracker: Tracker; task: ProviderTask; query: string; onSaid: (s: string) => void;
  /** Drawn inside a fact tile, which is already the box: no border of its own, the whole tile is the button. */
  bare?: boolean;
  /** The card as it is after a write, for a list that holds its own copy. */
  onTask?: (t: ProviderTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PeopleResult | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // Another card: what was asked for the last one is not this one's.
  useEffect(() => { setOpen(false); setRes(null); setQ(""); }, [task.id]);
  const ask = tracker.people;
  const write = tracker.setPeople;

  useEffect(() => {
    if (!open || !ask) return;
    let live = true;
    // Typing waits for a pause; opening with nothing typed asks at once.
    const t = setTimeout(() => {
      void ask(task, q).then((r) => { if (live) setRes(r); }).catch(() => { if (live) setRes({ ok: false, error: "Could not reach the server" }); });
    }, q.trim() ? PEOPLE_WAIT_MS : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, ask, task.customId, task.id]);

  if (!ask || !write || tracker.caps.multiAssignee) return null;
  const list: PersonOption[] = res?.ok ? (res.data ?? []) : [];
  // PeoplePick draws ListMembers; the row's position is its handle back to the person.
  const members: ListMember[] = list.map((p, i) => ({ id: i, name: p.name, initials: initialsOf(p.name), ...(p.avatar ? { avatar: p.avatar } : null) }));
  const on = task.people?.[0];

  const send = async (to: string | null, label: string) => {
    if (saving !== null) return;
    setSaving(to ?? "");
    onSaid(to ? "assigning…" : "taking off…");
    const r = await write(task, { set: to });
    setSaving(null);
    onSaid(r.ok ? label : `!${r.conflict ? "somebody changed this card while you had it open" : r.error || "the tracker refused that"}`);
    if (r.ok && r.task) { putCard(query, r.task); onTask?.(r.task); setOpen(false); }
  };
  const pick = (m: ListMember) => {
    const p = list[m.id];
    if (!p) return;
    void (isOnCard(task, p) ? send(null, `${p.name} off`) : send(p.key, `now ${p.name}`));
  };

  return (
    <>
      <button ref={btn} onClick={() => setOpen((v) => !v)}
        className={bare
          ? "agx-btn w-full text-left text-[12px] font-semibold flex items-center gap-1.5 min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-1"
          : "agx-btn agx-chip w-full text-left rounded-lg px-1.5 py-1 text-[11px] flex items-center gap-1.5 min-w-0 focus-visible:outline-none focus-visible:ring-1"}
        style={bare ? { color: on?.me ? "var(--success-ink)" : "var(--text)" } : { color: on?.me ? "var(--success)" : "var(--text2)", border: EDGE }}
        data-tip={tipAttr({ name: "Assign", text: "Give this card to somebody, or to nobody." })} aria-label="Assign this card"
        aria-haspopup="listbox" aria-expanded={open} data-dock={bare ? "assign" : undefined}>
        {on && face({ name: on.name, avatar: on.avatar, initials: on.initials, color: on.color })}
        <span className="min-w-0 truncate">{on ? (on.me ? (bare ? "You" : "you") : on.name) : (bare ? "Nobody" : "nobody")}</span>
        <span className="ml-auto shrink-0" style={{ color: "var(--text4)" }}>▾</span>
      </button>
      {open && (
        <PeoplePick
          anchor={btn}
          members={members}
          busy={res === null}
          onQuery={(v) => { setQ(v); setRes(null); }}
          isOn={(m) => !!list[m.id] && isOnCard(task, list[m.id]!)}
          isSaving={(m) => saving !== null && saving === list[m.id]?.key}
          onPick={pick}
          onClose={() => setOpen(false)}
          face={face}
          empty={res && !res.ok ? res.error : q.trim() ? `Nobody found for “${q.trim()}”.` : "Type a name to find somebody."}
          footer={
            <div className="flex flex-col">
              <ListRow disabled={!on || saving !== null} onClick={() => { void send(null, "unassigned"); }}>Nobody</ListRow>
              {/* Jira filters only the first part of its directory, so a short list is not everybody. */}
              <div className="px-1.5 pb-1 text-[10px]" style={{ color: "var(--text3)" }}>Not listed? Type more of the name.</div>
            </div>
          }
        />
      )}
    </>
  );
}
