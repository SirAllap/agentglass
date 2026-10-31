import type { ProviderTask } from "../../../../../shared/providers.ts";
import { FilterBuilder } from "../../tasks/FilterBuilder.tsx";
import { fieldsOf, type FilterSet } from "../../tasks/filters.ts";
import { useMemo } from "react";
import { Ctl, FunnelIcon } from "./ListControls.tsx";

/** The Filters builder (field, is / is not, values) with the list's own trigger; the panel hangs right under it and the count is live. */
export function FilterPanel({ cards, value, onChange }: { cards: readonly ProviderTask[]; value: FilterSet; onChange: (f: FilterSet) => void }) {
  const fields = useMemo(() => fieldsOf([...cards]), [cards]);
  return (
    <FilterBuilder fields={fields} value={value} onChange={onChange}
      trigger={({ ref, toggle, open, count }) => (
        <Ctl btnRef={ref} pressed={count > 0} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}
          tip={{ name: "Filters", text: "Build a filter: a field, is or is not, and its values." }}>
          <FunnelIcon /> Filters {count > 0 && <small className="tabular-nums" style={{ fontSize: 10.5, color: "var(--text3)" }}>{count}</small>}
        </Ctl>
      )} />
  );
}
