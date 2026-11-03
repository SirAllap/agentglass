import { useRef, useEffect, useState, type ReactElement } from "react";
import { ICON } from "../lib/iconSize.ts";
import { SparkleIcon } from "../lib/glyphIcons.tsx";
import { cleanAll, cleanTargets, confirmBody, progressWord, summaryWord, type CleanSummary } from "../lib/cleanAll.ts";
import { leftoverFor, useLeftoverVersion } from "../lib/leftoversStore.ts";
import { Button } from "./workspace/Chrome.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";

/**
 * The Closed tab's bulk action: every card whose inventory says something is left, cleaned one after another by the
 * same path as the card's own button (lib/cleanAll.ts). Hidden at zero. The cards refresh on the cleanup-done event.
 */
export function CleanAllButton({ root, rows }: { root: string; rows: readonly { number: number; state: string }[] }): ReactElement | null {
  useLeftoverVersion();
  const { ask, dialog } = useDialogs();
  const [at, setAt] = useState<{ n: number; of: number } | null>(null);
  const [sum, setSum] = useState<CleanSummary | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const targets = cleanTargets(rows, (pr, state) => leftoverFor(root, pr, state));

  const go = async (): Promise<void> => {
    if (at || targets.length === 0) return;
    if (!(await ask({ title: `Clean up ${targets.length} pull request${targets.length === 1 ? "" : "s"}?`, body: confirmBody(targets), confirmLabel: "Clean up all" }))) return;
    const prs = targets.map((t) => t.pr);
    setSum(null); setAt({ n: 1, of: prs.length });
    const s = await cleanAll(root, prs, (n) => { if (alive.current) setAt({ n, of: prs.length }); });
    if (alive.current) { setAt(null); setSum(s); }
  };

  if (targets.length === 0 && !at && !sum) return null;
  const failedTip = sum?.failed.map((f) => `#${f.pr}: ${f.why}`).join("\n");
  return (
    <>
      {sum && !at && (
        <span role="status" className="agx-srow-ss min-w-0 truncate" style={{ marginTop: 0, color: sum.failed.length ? "var(--warning-ink)" : undefined }} title={failedTip}>
          {summaryWord(sum)}{sum.failed.length ? ` (${sum.failed.map((f) => `#${f.pr}`).join(", ")})` : ""}
        </span>
      )}
      {at && <span role="status" className="agx-srow-ss" style={{ marginTop: 0 }}>{progressWord(at.n, at.of)}</span>}
      {targets.length > 0 && (
        <Button size="hit" tone="primary" disabled={!!at} onClick={() => void go()} title="Remove the local leftovers of every pull request listed here with some. Nothing on GitHub changes.">
          <SparkleIcon size={ICON.sm} />Clean up all ({targets.length})
        </Button>
      )}
      {dialog}
    </>
  );
}
