import { FlightPlanPage } from "../settings/pages/FlightPlanPage.tsx";
import { ScopeControl } from "../settings/scope/ScopeControl.tsx";
import { ScopeLedgerProvider, useScopeLedger } from "../settings/scope/ledger.tsx";
import { useScope } from "../settings/scope/useScope.ts";

/** The Flight plan page: its stored keys, for the one scope the page's control picks. */
export function FlightPlanSettings() {
  const sc = useScope();
  const { ledger, summary } = useScopeLedger(sc.choice);
  return (
    <ScopeLedgerProvider ledger={ledger}>
      <FlightPlanPage root={sc.root} choice={sc.choice}
        scopeSlot={<div className="flex flex-col gap-1.5"><ScopeControl {...sc.controlProps} />{summary}</div>} />
    </ScopeLedgerProvider>
  );
}
