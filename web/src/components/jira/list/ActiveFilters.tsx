/*
 * The chips, on the search row after the search box (no row of their own), present only while something is applied: the view's JQL
 * (purple, click to edit it in the box), a rule, the board's own scope marked "board", then one removable chip each and
 * "Clear all". They wrap among themselves when there are many; the Filters, Display and JQL controls stay put at the right.
 */
import { readableLabel } from "../../../lib/personNames.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { CrossIcon } from "../../../lib/glyphIcons.tsx";
import type { JiraListFilters } from "./model.ts";
import { chipsLine } from "./headerModel.ts";
import { CLEAR_ALL } from "./viewsModel.ts";

export function ActiveFilters({ filters, boardName, quickNames, epicNames, onFilters, onEditJql }: {
  filters: JiraListFilters; boardName: string | undefined; quickNames?: Readonly<Record<string, string>>; epicNames?: Readonly<Record<string, string>>; onFilters: (patch: Partial<JiraListFilters>) => void;
  /** The view's JQL chip was clicked: its search moves into the box. */
  onEditJql: () => void;
}) {
  const line = chipsLine(filters, boardName, quickNames, epicNames);
  if (!line.show) return null;
  const removable = line.chips.filter((c) => c.id !== "done").length;
  return (
    <div data-slot="active-filters" data-testid="jira-active-filters" className="agx-jf-line flex flex-wrap items-center min-w-0" style={{ gap: 4, minHeight: 28 }}>
      {line.jql && (
        <button type="button" data-testid="jira-view-jql-chip" className="agx-jf-jql truncate" data-tip={tipAttr({ name: "This view's search", text: line.jql, hint: { text: "Click to edit it in the box" } })} onClick={onEditJql}>{readableLabel(line.jql)}</button>
      )}
      {line.jql && (line.board || line.chips.length > 0) && <span aria-hidden className="agx-jf-sep" />}
      {line.board && (
        <span data-testid="jira-active-chip" data-board="" className="agx-jf-chip" data-on="" data-tip="This board's own filter">
          {line.board.label}<i>board</i>
        </span>
      )}
      {line.chips.map((c) => (
        <span key={c.id} data-testid="jira-active-chip" className="agx-jf-chip">
          <span className="truncate" style={{ maxWidth: 280 }}>{c.label}</span>
          <button type="button" aria-label={`Remove ${c.label}`} onClick={() => onFilters(c.clear!)}><CrossIcon size={ICON.xs} /></button>
        </span>
      ))}
      {removable > 0 && <button type="button" className="agx-jf-clear" onClick={() => onFilters(CLEAR_ALL)}>Clear all</button>}
    </div>
  );
}
