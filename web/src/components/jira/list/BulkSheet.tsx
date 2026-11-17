import { useEffect, useId, useRef, useState } from "react";
import { bulkWrite } from "../../../lib/jiraBulk.ts";
import { Button, EDGE, LINE } from "../../workspace/Chrome.tsx";
import { Frame, Foot, Head } from "./MoveConfirmDialog.tsx";
import { bulkSentence, failedKeys, foldResults, newValueOf, planBulk, runLine, type BulkAsk, type BulkCard, type RowState } from "./bulkModel.ts";

/*
 * The confirm sheet for a change to several cards: every card with what it holds now and what it will hold, one
 * sentence for the change, then a state per row while it writes. It stays open when a card fails, with "Retry failed"
 * for those cards only. Closing it reads the board again. The decisions live in bulkModel.ts.
 */

/** What the sheet shows as the card's value now, for the change being asked. */
function nowOf(c: BulkCard, ask: BulkAsk): string {
  switch (ask.kind) {
    case "sprint": case "backlog": return c.sprint ?? "Backlog";
    case "assignee": return c.assignee || "Nobody";
    case "priority": return c.priority ?? "None";
    case "parent": return c.parentKey ?? "None";
    case "flag": return c.flagged ? "Flagged" : "Not flagged";
    case "labels": return c.labels?.length ? c.labels.join(", ") : "None";
  }
}

export function BulkSheet({ cards, ask, onClose }: { cards: readonly BulkCard[]; ask: BulkAsk; onClose: (changed: boolean) => void }) {
  const id = useId();
  const plan = planBulk(cards, ask);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [phase, setPhase] = useState<"ask" | "run" | "end">("ask");
  const [failed, setFailed] = useState("");
  const changed = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { const t = setTimeout(() => cancelRef.current?.focus(), 30); return () => clearTimeout(t); }, []);
  const close = () => { if (phase !== "run") onClose(changed.current); };

  const run = async (keys: string[]) => {
    setPhase("run"); setFailed("");
    setRows((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, { s: "pending" } as RowState])) }));
    const a = await bulkWrite(keys, { kind: ask.kind, value: ask.value, add: ask.add, remove: ask.remove });
    // A refusal before any card (the write switch, a worker's token) has no results: say it once, not per card.
    if (!a.results?.length && a.error) setFailed(a.error);
    const folded = foldResults(keys, a.results);
    if (Object.values(folded).some((r) => r.s === "done")) changed.current = true;
    setRows((r) => ({ ...r, ...folded }));
    setPhase("end");
  };

  const bad = failedKeys(rows);
  const n = plan.change.length;
  const sub = phase === "end" ? (failed || runLine(rows)) : plan.tooMany ? "Pick at most 50 cards at a time" : plan.skip.length ? `${plan.skip.length} already ${plan.skip.length === 1 ? "has" : "have"} this and ${plan.skip.length === 1 ? "is" : "are"} left alone` : "Nothing is written until you apply";
  return (
    <Frame labelId={id} onEsc={close} busy={phase === "run"}>
      <Head id={id} title={n ? bulkSentence(n, ask) : "Nothing to change"} sub={sub} />
      <div className="agx-dialog-body px-4 pb-3 flex-1 min-h-0 overflow-y-auto" tabIndex={0} aria-label="Cards to change">
        {[...plan.change, ...plan.skip].map((c) => {
          const skipped = plan.skip.includes(c);
          const st = rows[c.key];
          return (
            <div key={c.key} className="grid items-center gap-2 py-1 text-[12px]" style={{ gridTemplateColumns: "70px 1fr auto", borderBottom: LINE, opacity: skipped ? 0.55 : 1 }}>
              <span className="text-[11px]" style={{ fontFamily: "var(--mono, monospace)", color: "var(--text3)" }}>{c.key}</span>
              <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{c.title}</span>
              <span className="flex items-center gap-1.5 min-w-0" style={{ color: "var(--text2)" }}>
                {skipped ? <span>Already there</span> : st?.s === "pending" ? <span role="status">Writing…</span>
                  : st?.s === "done" ? <span style={{ color: "var(--success, var(--primary))" }}>Done</span>
                  : st?.s === "failed" ? <span style={{ color: "var(--warning)" }}>{st.error}</span>
                  : <><span className="truncate">{nowOf(c, ask)}</span><span aria-hidden style={{ color: "var(--text3)" }}>→</span><b className="truncate font-semibold" style={{ color: "var(--text)" }}>{newValueOf(ask)}</b></>}
              </span>
            </div>
          );
        })}
      </div>
      <Foot>
        <span className="flex-1" />
        {phase === "end" && bad.length > 0 && !failed && <Button onClick={() => void run(bad)}>Retry failed</Button>}
        {phase === "end" && failed && <Button onClick={() => void run(plan.change.map((c) => c.key))}>Try again</Button>}
        <button ref={cancelRef} type="button" className="agx-jbulk-b" onClick={close} disabled={phase === "run"} style={{ boxShadow: EDGE }}>{phase === "end" ? "Close" : "Cancel"}</button>
        {phase === "ask" && <Button tone="primary" disabled={!n || plan.tooMany} onClick={() => void run(plan.change.map((c) => c.key))}>Apply to {n} {n === 1 ? "card" : "cards"}</Button>}
      </Foot>
    </Frame>
  );
}
