import { useEffect, useRef, useState } from "react";
import { createDangerArm } from "./dangerArm.ts";
import { HIT } from "../../../lib/iconSize.ts";

export function DangerAction({ label, onConfirm }: { label: string; onConfirm: () => void | Promise<unknown> }) {
  const [armed, setArmed] = useState(false);
  const [res, setRes] = useState<"done" | "failed" | null>(null);
  const run = useRef(onConfirm);
  run.current = onConfirm;
  const ref = useRef<ReturnType<typeof createDangerArm> | null>(null);
  if (!ref.current) ref.current = createDangerArm({
    run: () => { setRes(null); void Promise.resolve().then(() => run.current()).then(() => setRes("done"), () => setRes("failed")); },
    onChange: setArmed,
  });
  const a = ref.current;
  useEffect(() => () => a.disarm(), [a]);
  return (
    <>
    {res && <span role={res === "done" ? "status" : "alert"} className="text-[11px] font-medium" style={{ color: res === "done" ? "var(--success-ink)" : "var(--error-ink)" }}>{res === "done" ? "Done" : "Did not work"}</span>}
    <button
      type="button"
      aria-live="polite"
      onClick={() => a.press()}
      onBlur={() => a.disarm()}
      onKeyDown={(e) => { if (e.key === "Escape") a.disarm(); }}
      className="text-[12px] font-medium px-3 rounded-md"
      style={{
        height: HIT,
        color: armed ? "var(--bg)" : "var(--error)",
        background: armed ? "var(--error)" : "transparent",
        boxShadow: "inset 0 0 0 1px var(--error)",
      }}
    >
      {armed ? "Press again to confirm" : label}
    </button>
    </>
  );
}
