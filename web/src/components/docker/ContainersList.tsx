/*
 * The Containers list pane: the sentence, the three answers, the map, then the
 * stacks. Everything it decides comes from the lib modules; this wires them to
 * the menus and the inline confirms, which are local to the list because only
 * the list has a row to ask under.
 */
import { useRef, useState } from "react";
import type { DockerContainer, DockerStat } from "../../../../shared/types.ts";
import { ageWords, mapGroups, type GroupBy, type GroupView } from "../../lib/dockerView.ts";
import { triage, type Answer } from "../../lib/dockerTriage.ts";
import type { MenuItem, RowVerb } from "../../lib/dockerState.ts";
import { Button } from "../workspace/Chrome.tsx";
import { AnswerCards, Say } from "./AnswerCards.tsx";
import { ContainerRow } from "./ContainerRow.tsx";
import { MapStrip } from "./MapStrip.tsx";
import { GroupMenu, RowMenu, type GroupPick } from "./RowMenu.tsx";
import { StackCard } from "./StackCard.tsx";
import { DaemonBanner } from "./States.tsx";

type Menu = { kind: "row"; id: string } | { kind: "group"; key: string } | null;
type GroupAsk = { key: string; verb: "restart" | "stop"; ids: string[] } | null;

export function ContainersList({
  all, groups, stats, readOnly, busy, dense, selected, answer, onAnswer, groupBy, q, onClearQ,
  confirm, onRowConfirm, onOpen, onVerb, onMenuPick, onGroup, onToggleGroup, onOpenPort, down, onTry,
}: {
  all: DockerContainer[]; groups: GroupView[]; stats: Record<string, DockerStat>;
  readOnly: boolean; busy: string | null; dense: boolean; selected: string | null;
  answer: Answer | null; onAnswer: (a: Answer | null) => void;
  groupBy: GroupBy; q: string; onClearQ: () => void;
  confirm: { id: string; verb: "stop" | "rm" } | null;
  onRowConfirm: (yes: boolean) => void;
  onOpen: (id: string) => void;
  onVerb: (c: DockerContainer, verb: RowVerb) => void;
  onMenuPick: (c: DockerContainer, verb: MenuItem["verb"]) => void;
  onGroup: (verb: GroupPick, ids: string[]) => void;
  onToggleGroup: (key: string, folded: boolean) => void;
  onOpenPort: (url: string) => void;
  /** Set when the daemon is gone: the last state stays, dimmed, under a banner. */
  down: { error?: string; at?: number } | null;
  onTry: () => void;
}) {
  const [menu, setMenu] = useState<Menu>(null);
  const [ask, setAsk] = useState<GroupAsk>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const open = (m: Menu) => (el: HTMLElement) => { anchor.current = el; setMenu(m); };

  const statList = Object.values(stats);
  const t = triage(all, statList);
  const shown = new Set(groups.flatMap((g) => g.containers.map((c) => c.id)));
  const byId = new Map(all.map((c) => [c.id, c]));
  const menuRow = menu?.kind === "row" ? byId.get(menu.id) : undefined;
  const menuGroup = menu?.kind === "group" ? groups.find((g) => g.key === menu.key) : undefined;

  const groupVerb = (key: string, verb: GroupPick, ids: string[]) => {
    if (verb === "start") onGroup("start", ids);
    else setAsk({ key, verb, ids });
  };

  return (
    <div className="agx-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 18px 18px" }}>
      {down && <DaemonBanner error={down.error} age={down.at ? ageWords(Date.now() - down.at) : undefined} onTry={onTry} />}
      <div className={down ? "dk-dimmed" : undefined} aria-disabled={down ? true : undefined}>
        <Say t={t} />
        <AnswerCards t={t} active={answer} onPick={(a) => onAnswer(answer === a ? null : a)} />
        <MapStrip groups={mapGroups(all, groupBy)} inFilter={shown} selected={selected} onPick={onOpen} />
        {groups.length ? groups.map((g) => (
          <StackCard key={g.key} group={g} readOnly={readOnly || !!down} busy={busy === "group"} folded={g.folded}
            menuOpen={menu?.kind === "group" && menu.key === g.key}
            confirm={ask?.key === g.key ? { verb: ask.verb, n: ask.ids.length } : null}
            onToggle={() => onToggleGroup(g.key, g.folded)}
            onMenu={open({ kind: "group", key: g.key })}
            onGroupVerb={(verb, ids) => groupVerb(g.key, verb, ids)}
            onConfirm={(yes) => { const a = ask; setAsk(null); if (yes && a) onGroup(a.verb, a.ids); }}>
            {g.containers.map((c) => (
              <ContainerRow key={c.id} c={c} stat={stats[c.id]} selected={selected === c.id} dense={dense}
                readOnly={readOnly || !!down} busy={busy === c.id}
                confirm={confirm?.id === c.id ? confirm.verb : null}
                menuOpen={menu?.kind === "row" && menu.id === c.id}
                onSelect={() => onOpen(c.id)} onVerb={(v) => onVerb(c, v)}
                onMenu={open({ kind: "row", id: c.id })} onOpenPort={onOpenPort} onConfirm={onRowConfirm} />
            ))}
          </StackCard>
        )) : (
          <div className="dk-empty-s">
            {answer ? "Nothing in this group." : `Nothing matches “${q}”.`}{" "}
            <Button size="compact" onClick={() => { onAnswer(null); onClearQ(); }}>Clear the filter</Button>
          </div>
        )}
      </div>
      {menuRow && <RowMenu anchor={anchor} c={menuRow} where="row" readOnly={readOnly || !!down} onPick={(v) => onMenuPick(menuRow, v)} onClose={() => setMenu(null)} />}
      {menuGroup && <GroupMenu anchor={anchor} cs={menuGroup.containers} readOnly={readOnly || !!down} onPick={(v, ids) => groupVerb(menuGroup.key, v, ids)} onClose={() => setMenu(null)} />}
    </div>
  );
}
