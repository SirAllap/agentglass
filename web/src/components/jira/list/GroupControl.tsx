import type { GroupBy, ThenBy } from "../../../lib/jiraAreas.ts";
import { ContextMenu } from "../../ContextMenu.tsx";
import { useMenuAt } from "../../tasks/TaskMenu.tsx";
import { Caret, Ctl, Eyebrow } from "./ListControls.tsx";
import { MenuRowBtn } from "./MenuParts.tsx";
import { groupChoices, thenChoices, withGroup } from "./toolbarModel.ts";
import type { JiraListFilters } from "./model.ts";

function Pick<T extends string>({ label, tip, value, options, onPick }: {
  label: string; tip: string; value: T; options: { value: T; label: string }[]; onPick: (v: T) => void;
}) {
  const { at, open, close } = useMenuAt();
  const now = options.find((o) => o.value === value)?.label ?? value;
  return (
    <>
      <Ctl aria-haspopup="menu" aria-expanded={!!at} aria-label={`${label}: ${now}`} tip={tip} onClick={(e) => open(e.currentTarget)}>{now} <Caret /></Ctl>
      {at && (
        <ContextMenu x={at.x} y={at.y} onClose={close} width={180} plain label={label}>
          {options.map((o) => <MenuRowBtn key={o.value} on={o.value === value} label={o.label} onClick={() => { onPick(o.value); close(); }}>{o.label}</MenuRowBtn>)}
        </ContextMenu>
      )}
    </>
  );
}

/** Group by, and the second split inside each group. Area is offered only where the board has epics. */
export function GroupControl({ filters, onFilters, hasAreas }: {
  filters: JiraListFilters; onFilters: (patch: Partial<JiraListFilters>) => void; hasAreas: boolean;
}) {
  return (
    <span className="inline-flex items-center shrink-0" style={{ gap: 8 }} data-testid="jira-group-control">
      <Eyebrow>Group</Eyebrow>
      <Pick<GroupBy> label="Group" tip="Group the cards by" value={filters.group} options={groupChoices(hasAreas)} onPick={(by) => onFilters(withGroup(by))} />
      <Eyebrow>Then</Eyebrow>
      <Pick<ThenBy> label="Then" tip="Then split each group by" value={filters.thenGroup} options={thenChoices(filters.group, hasAreas)} onPick={(thenGroup) => onFilters({ thenGroup })} />
    </span>
  );
}
