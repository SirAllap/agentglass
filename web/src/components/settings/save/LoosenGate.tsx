import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "../../workspace/Chrome.tsx";
import { askText, createLoosenGate, type Pending } from "./loosen.ts";

/** The inline question on a row that is about to loosen something: one sentence, Allow or Cancel. Nothing is saved until Allow. */
export function LoosenConfirm({ what, onAllow, onCancel, replaced }: { what: string; onAllow: () => void; onCancel: () => void; replaced?: boolean }) {
  return (
    <div role="group" aria-label="Confirm a wider permission" data-loosen-confirm className="mt-1 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--text)" }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}>
      {replaced && <span style={{ color: "var(--text2)" }}>The earlier question was cancelled.</span>}
      <span>{askText(what)}</span>
      <Button size="compact" tone="primary" onClick={onAllow}>Allow</Button>
      <Button size="compact" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/**
 * One pending question per component, shown on the row that raised it. `gate(row, what, run)` runs `run` at once
 * when `what` is null (a tightening change) and otherwise waits for Allow. A second change on any row replaces the first.
 */
export function useLoosenGate() {
  const [pending, setPending] = useState<Pending | null>(null);
  const core = useRef<ReturnType<typeof createLoosenGate> | null>(null);
  if (!core.current) core.current = createLoosenGate(setPending);
  const c = core.current;
  const gate = useCallback((row: string, what: string | null, run: () => void) => c.gate(row, what, run), [c]);
  const at = (row: string): ReactNode => pending?.row === row ? <LoosenConfirm what={pending.what} replaced={pending.replaced} onAllow={() => c.allow()} onCancel={() => c.cancel()} /> : null;
  const cancel = useCallback(() => c.cancel(), [c]);
  return { gate, at, pending, cancel };
}
