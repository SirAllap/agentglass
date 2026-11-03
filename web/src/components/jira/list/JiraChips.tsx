import { avatarSrc } from "../../../lib/avatarSrc.ts";
import { Ctl } from "./ListControls.tsx";
import { FilterPanel } from "./FilterPanel.tsx";
import { GroupControl } from "./GroupControl.tsx";
import type { JiraListFilters, JiraListModel } from "./model.ts";
import { StatusMenu } from "./StatusMenu.tsx";
import { myFaceOf, showDoneLabel } from "./toolbarModel.ts";

/** The chips row: shortcuts that narrow the page, Status and Filters for everything else, the board's own quick filters, and how to group at the right. */
export interface JiraChipsProps {
  model: JiraListModel;
  filters: JiraListFilters;
  onFilters: (patch: Partial<JiraListFilters>) => void;
  /** An open epic (not the sprint page): offers "Sprint only / All n" when the board has a sprint. */
  areaId?: string | null;
}

const MAX_TAGS = 3;

export function JiraChips({ model, filters, onFilters, areaId }: JiraChipsProps) {
  const loading = model.phase === "loading";
  const n = (v: number) => (loading ? "–" : v);
  const face = myFaceOf(model.cards);
  const quick = model.context?.filters ?? [];
  const epicOpen = !!areaId && !areaId.startsWith("@");
  const sprint = model.sprint;
  const toggleQuick = (id: string) => onFilters({ quick: filters.quick.includes(id) ? filters.quick.filter((x) => x !== id) : [...filters.quick, id] });
  const count = (v: number | string) => <small className="tabular-nums" style={{ fontSize: 10.5, color: "var(--text3)", fontWeight: 400 }}>{v}</small>;

  return (
    <div data-slot="chips" className="flex items-center flex-wrap shrink-0" style={{ gap: 8, padding: "0 24px" }}>
      <Ctl pressed={filters.readyOnly} onClick={() => onFilters({ readyOnly: !filters.readyOnly })}
        tip={{ name: "Ready", text: "Cards nothing unfinished is blocking." }}>
        Ready {count(n(model.counts.ready))}
      </Ctl>
      <Ctl tone="ok" pressed={filters.mineOnly} onClick={() => onFilters({ mineOnly: !filters.mineOnly })}
        tip={{ name: "Mine", text: "Only the cards assigned to you." }}>
        {face && <img src={avatarSrc(face)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }}
          className="rounded-full shrink-0" style={{ width: 16, height: 16, objectFit: "cover" }} />}
        Mine {count(n(model.counts.mine))}
      </Ctl>
      {model.tags.slice(0, MAX_TAGS).map((t) => (
        <Ctl key={t} pressed={filters.tag === t} onClick={() => onFilters({ tag: filters.tag === t ? null : t })}
          tip={{ name: `#${t}`, text: "Only the cards with this label." }}>
          #{t}
        </Ctl>
      ))}
      <span aria-hidden className="self-stretch" style={{ width: 1, margin: "4px 0", background: "var(--surface-line)" }} />
      <StatusMenu statuses={model.statuses} cards={model.cards} picked={filters.statusPick} onPick={(statusPick) => onFilters({ statusPick })} />
      <FilterPanel cards={model.cards} value={filters.built} onChange={(built) => onFilters({ built })} />
      {quick.map((q) => (
        <Ctl key={q.id} pressed={filters.quick.includes(q.id)} onClick={() => toggleQuick(q.id)} tip={{ name: q.name, text: q.description || "One of this board's own quick filters." }}>
          {q.name}
        </Ctl>
      ))}
      {/* One cluster with auto margin: it stays at the right edge on a wrapped line too, which a flex spacer would not. */}
      <span className="inline-flex items-center shrink-0 ml-auto" style={{ gap: 8 }}>
      {epicOpen && sprint && (
        <span role="group" aria-label="Scope" className="inline-flex shrink-0" style={{ gap: 2, padding: 2, borderRadius: 9, background: "var(--surface-inset)" }}>
          {([[sprint.name, `${sprint.name} only`, sprint.name], ["all", `All ${model.counts.total}`, null]] as const).map(([id, label, v]) => (
            <button key={id} type="button" aria-pressed={filters.sprintOnly === v} onClick={() => onFilters({ sprintOnly: v })}
              className="agx-chip" style={{
                height: 24, padding: "0 12px", borderRadius: 7, fontSize: 11, whiteSpace: "nowrap",
                ...(filters.sprintOnly === v
                  ? { background: "var(--bg)", color: "var(--text)", fontWeight: 600, boxShadow: "0 1px 2px color-mix(in srgb, var(--shadow) 20%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent)" }
                  : { background: "transparent", color: "var(--text3)" }),
              }}>{label}</button>
          ))}
        </span>
      )}
      <GroupControl filters={filters} onFilters={onFilters} hasAreas={model.epics.length > 0} />
      <Ctl pressed={filters.showDone} onClick={() => onFilters({ showDone: !filters.showDone })}
        tip={filters.showDone ? { name: "Showing everything", text: "Every status this board has, finished ones included." } : { name: `Show ${model.counts.done} done`, text: "Bring back the cards in a finished status." }}>
        {loading ? "Show – done" : showDoneLabel(filters.showDone, model.counts.done)}
      </Ctl>
      </span>
    </div>
  );
}
