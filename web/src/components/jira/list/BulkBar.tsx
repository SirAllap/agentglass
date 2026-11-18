/*
 * The bar that floats over the list once a card is picked (x, or the row's own checkbox): how many, and the few things
 * a set of cards can do together without a write the board cannot undo on its own — copy their keys, open them as one
 * Jira search, or clear the pick. It renders nothing with nothing picked.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JiraBoardEpic, JiraPerson, ProviderTask } from "../../../../../shared/providers.ts";
import { bulkOptions, bulkPeople, BOARD_READS, type BulkOptions } from "../../../lib/jiraBulk.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { ArrowIcon, CaretIcon, CopyIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { Kbd } from "../../projects/ui.tsx";
import { Select } from "../../Select.tsx";
import { PeoplePick } from "../../PeoplePick.tsx";
import { Face } from "../../AssignPicker.tsx";
import { Flag } from "../../../lib/priority.tsx";
import { ListRow } from "../../workspace/Chrome.tsx";
import type { JiraBoardContext } from "../../../../../shared/providers.ts";
import { peopleMembers, priorityChoices, sprintEmptyNote } from "./bulkPickers.ts";
import { resolveBulkSprints, type Scope } from "./bulkSprintScope.ts";
import { BulkSheet } from "./BulkSheet.tsx";
import type { BulkAsk, BulkCard } from "./bulkModel.ts";
import { keyOf } from "./laneModel.ts";

export interface BulkBarProps {
  count: number;
  onCopyKeys: () => void;
  onOpenJql: (() => void) | null;
  onClear: () => void;
  /** Put the picked cards in the board's active sprint; null where the tracker has no sprints to write. */
  onSprint?: (() => void) | null;
  /** More buttons after the built-in ones (the board's "Move to"). */
  extra?: ReactNode;
}

export function BulkBar({ count, onCopyKeys, onOpenJql, onClear, onSprint, extra }: BulkBarProps) {
  if (count <= 0) return null;
  return (
    <div className="agx-jbulk" role="toolbar" aria-label={`${count} cards picked`}>
      <b className="agx-jbulk-n">{count} selected</b>
      <button type="button" className="agx-jbulk-b" onClick={onCopyKeys} data-tip={tipAttr("Copy the keys")}>
        <CopyIcon size={ICON.sm} />Copy keys
      </button>
      {onOpenJql && (
        <button type="button" className="agx-jbulk-b" onClick={onOpenJql} data-tip={tipAttr("Open these cards as one Jira search")}>
          <ArrowIcon size={ICON.sm} />Open in Jira
        </button>
      )}
      {onSprint && (
        <button type="button" className="agx-jbulk-b" onClick={onSprint} data-tip={tipAttr("Put these cards in the board's active sprint")}>
          <ArrowIcon size={ICON.sm} />Move to current sprint
        </button>
      )}
      {extra}
      <button type="button" className="agx-jbulk-b" onClick={onClear}>Clear <Kbd>Esc</Kbd></button>
    </div>
  );
}

/** A card as the sheet needs it. The picked cards are what the board read gave; a field the card does not carry stays unknown. */
export function bulkCardOf(t: ProviderTask): BulkCard {
  const people = t.people ?? [];
  return {
    key: keyOf(t), title: t.title,
    sprintId: t.sprintId ?? null, sprint: t.sprint ?? null,
    assigneeKeys: people.map((p) => p.key ?? "").filter(Boolean), assignee: t.assignees.join(", "),
    priority: t.priority, parentKey: t.parent?.key ?? null,
    labels: t.tags, flagged: t.flagged === true,
  };
}

function Menu({ label, tip, children, open, onOpen }: { label: string; tip: string; children: ReactNode; open: boolean; onOpen: (o: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, onOpen]);
  return (
    <div className="agx-jbulk-menu" ref={box}>
      <button type="button" className="agx-jbulk-b" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)} data-tip={tipAttr(tip)}>
        {label}<CaretIcon size={ICON.xs} />
      </button>
      {open && <ul role="menu" className="agx-jb-selmenu">{children}</ul>}
    </div>
  );
}
const Item = ({ onPick, children }: { onPick: () => void; children: ReactNode }) => (
  <li role="none"><button type="button" role="menuitem" onClick={onPick}>{children}</button></li>
);

/**
 * The write buttons of the bar: Sprint, Assignee, Priority, Epic, Labels and Flag. Each menu picks a value, and the
 * pick opens the confirm sheet (BulkSheet.tsx); nothing is written before its Apply. Hidden with the write switch off.
 */
export function BulkActions({ picked, board, context, epics, writable, onDone }: { picked: readonly ProviderTask[]; board: string; /** The board view's own read; null in a list, filter or JQL view, where the picked card's board is resolved as the card menu does. */ context: JiraBoardContext | null; epics: readonly JiraBoardEpic[]; writable: boolean; onDone: () => void }) {
  const [open, setOpen] = useState("");
  const [ask, setAsk] = useState<BulkAsk | null>(null);
  const [label, setLabel] = useState("");
  const [opts, setOpts] = useState<BulkOptions | null>(null);
  const [people, setPeople] = useState<JiraPerson[] | null>(null);
  const assignBtn = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [tries, setTries] = useState(0);
  const pickedKey = picked.map((t) => t.id).join(",");
  const project = picked[0] ? keyOf(picked[0]).replace(/-\d+$/, "") : "";
  // The choices are read when a menu first opens, not for every pick of a card.
  useEffect(() => {
    if (open === "sprint" && !scope) {
      let gone = false;
      void resolveBulkSprints(picked, context, BOARD_READS).then((r) => { if (!gone) setScope(r); });
      return () => { gone = true; };
    }
    if (open === "priority") { if (!opts) void bulkOptions(board).then((o) => { if (o) setOpts(o); }); }
    if (open === "assignee" && !people && project) void bulkPeople(project).then(setPeople);
  }, [open, opts, people, board, project, scope, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // A different set of cards, or board view, asks again.
  useEffect(() => { setScope(null); }, [pickedKey, context]);
  if (!writable) return null;
  const pick = (a: BulkAsk) => { setOpen(""); setAsk(a); };
  const menu = (id: string) => ({ open: open === id, onOpen: (o: boolean) => setOpen(o ? id : "") });
  const sprints = scope?.ok ? scope.choices : [];
  const noSprints = scope?.ok ? sprintEmptyNote(scope, sprints) : null;
  const members = people ? peopleMembers(people) : null;
  const prios = priorityChoices(opts?.priorities ?? []);
  return (
    <>
      <Menu label="Sprint" tip="Move these cards to a sprint or the backlog" {...menu("sprint")}>
        {!scope && <li className="px-2 py-1 text-[12px]" style={{ color: "var(--text3)" }}>Reading sprints…</li>}
        {scope && !scope.ok && (
          <>
            <li className="px-2 py-1 text-[12px]" style={{ color: "var(--text3)" }}>{scope.error}</li>
            <Item onPick={() => { setScope(null); setTries((n) => n + 1); }}>Retry</Item>
          </>
        )}
        {scope?.ok && scope.note && <li className="px-2 py-1 text-[12px]" style={{ color: "var(--text3)" }}>{scope.note}</li>}
        {noSprints && <li className="px-2 py-1 text-[12px]" style={{ color: "var(--text3)" }}>{noSprints}</li>}
        {sprints.map((s) => <Item key={s.id} onPick={() => pick({ kind: "sprint", value: s.id, label: s.name })}>{s.name}{s.tag ? ` · ${s.tag}` : ""}{s.dates ? ` · ${s.dates}` : ""}</Item>)}
        {scope?.ok && <Item onPick={() => pick({ kind: "backlog" })}>Backlog</Item>}
      </Menu>
      <div className="agx-jbulk-menu">
        <button ref={assignBtn} type="button" className="agx-jbulk-b" aria-haspopup="menu" aria-expanded={open === "assignee"} onClick={() => setOpen(open === "assignee" ? "" : "assignee")} data-tip={tipAttr("Give these cards to somebody")}>
          Assignee<CaretIcon size={ICON.xs} />
        </button>
        {open === "assignee" && (
          <PeoplePick anchor={assignBtn} members={members} prefer="above" label="Give the cards to" empty="Nobody matches that."
            isOn={() => false}
            onPick={(m) => { const x = people?.[Number(m.id)]; if (x) pick({ kind: "assignee", value: x.key, label: x.name }); }}
            onClose={() => setOpen("")}
            face={(m) => <Face m={m} />}
            footer={<ListRow onClick={() => pick({ kind: "assignee", value: null })} sub="takes whoever is on the cards off them">Nobody</ListRow>} />
        )}
      </div>
      <Select value="" className="agx-jbulk-b" title="Set the priority of these cards" loading={!opts} onOpen={() => setOpen("priority")}
        trigger={<>Priority<CaretIcon size={ICON.xs} /></>}
        onChange={(id) => { const o = prios.find((x) => x.id === id); if (o) pick({ kind: "priority", value: o.id, label: o.label }); }}
        options={prios.map((o) => ({ value: o.id, label: o.label, icon: <Flag c={o.c} on />, tint: o.c }))} />
      <Menu label="Epic" tip="Put these cards under an epic" {...menu("epic")}>
        <Item onPick={() => pick({ kind: "parent", value: null })}>No epic</Item>
        {epics.filter((e) => !e.done).map((e) => <Item key={e.key} onPick={() => pick({ kind: "parent", value: e.key, label: `${e.key} ${e.name}` })}>{e.name}</Item>)}
      </Menu>
      <Menu label="Labels" tip="Add or take off a label" {...menu("labels")}>
        <li role="none" className="px-1 pb-1">
          <input className={`${INPUT} w-full`} style={INPUT_STYLE} placeholder="A label, no spaces" aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value.replace(/[\s,]/g, ""))} />
        </li>
        <Item onPick={() => { if (label) { pick({ kind: "labels", add: [label] }); setLabel(""); } }}>Add this label</Item>
        <Item onPick={() => { if (label) { pick({ kind: "labels", remove: [label] }); setLabel(""); } }}>Take this label off</Item>
      </Menu>
      <Menu label="Flag" tip="Flag these cards, or take the flag off" {...menu("flag")}>
        <Item onPick={() => pick({ kind: "flag", value: true })}>Flag</Item>
        <Item onPick={() => pick({ kind: "flag", value: false })}>Remove flag</Item>
      </Menu>
      {ask && <BulkSheet cards={picked.map(bulkCardOf)} ask={ask} onClose={(changed) => { setAsk(null); if (changed) onDone(); }} />}
    </>
  );
}
