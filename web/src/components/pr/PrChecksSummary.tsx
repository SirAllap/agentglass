import { Button } from "../workspace/Chrome.tsx";
import { ClockIcon, CrossIcon, DoneIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import type { ChecksSummary } from "../../lib/prOverviewBody.ts";
import { PrSection } from "./PrSection.tsx";

/** The checks at a glance: a bar, the rows that need a look, and the way to the full tab. */
export function PrChecksSummary({ s, onAll }: { s: ChecksSummary; onAll: () => void }) {
  if (s.total === 0) return null;
  return (
    <PrSection title="Checks" count={s.label} testid="pr-checks-summary"
      action={<Button size="compact" tone="quiet" onClick={onAll}>All checks</Button>}>
      <div className="prov-bar" aria-hidden="true">
        {s.bar.ok > 0 && <i style={{ ["--c" as string]: "var(--success)", flex: s.bar.ok }} />}
        {s.bar.bad > 0 && <i style={{ ["--c" as string]: "var(--error)", flex: s.bar.bad }} />}
        {s.bar.run > 0 && <i style={{ ["--c" as string]: "var(--warning)", flex: s.bar.run }} />}
      </div>
      <div className="prov-list">
        {s.rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="prov-row" data-tone={r.tone}>
            <span aria-hidden className="prov-row-i">
              {r.tone === "ok" ? <DoneIcon size={ICON.xs} /> : r.tone === "bad" ? <CrossIcon size={ICON.xs} /> : <ClockIcon size={ICON.xs} />}
            </span>
            <span className="prov-nm">{r.name}</span>
            <span className="prov-dur">{r.dur}</span>
          </div>
        ))}
      </div>
    </PrSection>
  );
}
