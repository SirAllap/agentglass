import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SAME_EVERYWHERE, summaryText, type ScopeChoice, type ScopeRow } from "./scopeModel.ts";
import { ScopeSummary } from "./ScopeControl.tsx";

/*
 * Rows tell the page whether they differ from All projects, so the header can
 * say how many do and "Show them" can filter the page to those rows. Nothing
 * here stores a value: it only counts what the rows already read.
 */
interface Ledger { report: (id: string, differs: boolean) => void; onlyDiffering: boolean }
const LedgerCtx = createContext<Ledger | null>(null);

export function useScopeLedger(choice: ScopeChoice) {
  const [map, setMap] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(false);
  const report = useCallback((id: string, differs: boolean) => setMap((m) => (m[id] === differs ? m : { ...m, [id]: differs })), []);
  const rows: ScopeRow[] = useMemo(() => Object.entries(map).filter(([, d]) => d).map(([id]) => ({ id, general: 0, own: 1 })), [map]);
  const only = shown && choice === "project";
  const ledger = useMemo<Ledger>(() => ({ report, onlyDiffering: only }), [report, only]);
  const summary = (
    <ScopeSummary text={summaryText(rows, choice)} filtered={only} onShow={() => setShown((s) => !s)} />
  );
  return { ledger, summary };
}

export function ScopeLedgerProvider({ ledger, children }: { ledger: Ledger; children: ReactNode }) {
  return <LedgerCtx.Provider value={ledger}>{children}</LedgerCtx.Provider>;
}

/** A row reports whether it differs; the page counts it. */
export function useReportRow(id: string, differs: boolean): void {
  const l = useContext(LedgerCtx);
  useEffect(() => { l?.report(id, differs); }, [l, id, differs]);
}

/** "Show them" hides the rows that do not differ. */
export function ScopeFilter({ differs, children }: { differs: boolean; children: ReactNode }) {
  const l = useContext(LedgerCtx);
  return l?.onlyDiffering && !differs ? null : <>{children}</>;
}

/**
 * Machine values: they cannot differ per project. Under Only <project> they are
 * locked and say what they are and how to change it; under All projects they edit as usual.
 */
export function MachineLock({ choice, onAll, children }: { choice: ScopeChoice; onAll?: () => void; children: ReactNode }) {
  const locked = choice === "project";
  return (
    <ScopeFilter differs={false}>
      <div data-machine-lock={locked ? "locked" : "open"}>
        {locked && <div data-scope-tag="locked" className="px-3 pt-2 text-[12px]" style={{ color: "var(--text3)" }}>{SAME_EVERYWHERE}{" "}
          {onAll ? <button type="button" className="underline" style={{ color: "var(--accent)" }} onClick={onAll}>All projects</button> : "All projects"}{" "}to change it.</div>}
        <div aria-disabled={locked || undefined} {...(locked ? { inert: "" } : null)} style={locked ? { opacity: 0.55, pointerEvents: "none" } : undefined}>{children}</div>
      </div>
    </ScopeFilter>
  );
}
