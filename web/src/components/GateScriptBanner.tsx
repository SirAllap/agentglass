// Says, in the Lantern, that the gate is wired to a script that is gone.
//
// The gate's command checks that its script exists and lets a call through when
// it does not (server/src/hooksetup.ts, `gateCommand`): failing closed there
// would block every tool call in every session over a moved checkout. The cost
// is that nothing is being held, and that has to be seen, not discovered when
// an outward call goes out unasked. Installing the hook again re-points it at
// this build's script.
import { useCallback, useEffect, useState } from "react";
import { api, IS_DEMO } from "../lib/api.ts";
import { EDGE } from "./workspace/Chrome.tsx";

export function GateScriptView({ busy, error, onFix, denies = false }: { busy: boolean; error: string | null; onFix: () => void; denies?: boolean }) {
  return (
    <div
      role="alert"
      className="shrink-0 px-3 py-2 rounded-lg text-[11px] flex items-center gap-2 flex-wrap"
      style={{
        background: "color-mix(in srgb, var(--warning) 12%, transparent)",
        border: EDGE,
        color: "var(--text)",
      }}
    >
      <span className="font-semibold" style={{ color: "var(--warning-ink)" }}>
        {denies ? "The gate is denying every tool call" : "The gate is not holding anything"}
      </span>
      <span>
        The hook in your Claude Code settings points at a gate script that has moved or been deleted, so
        {denies ? " every tool call is refused (it was installed before the check for this existed)." : " tool calls go through without waiting for you."}
      </span>
      <button
        onClick={onFix}
        disabled={busy}
        className="text-[11px] px-2.5 min-h-[28px] inline-flex items-center rounded-lg whitespace-nowrap font-medium"
        style={{ color: "var(--text)", border: EDGE, opacity: busy ? 0.5 : 1 }}
      >{busy ? "Installing…" : "Install the gate again"}</button>
      {error && <span style={{ color: "var(--error-ink)" }}>{error}</span>}
    </div>
  );
}

export default function GateScriptBanner({ active }: { active: boolean }) {
  const [missing, setMissing] = useState(false);
  const [denies, setDenies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(() => {
    api.hooksStatus().then((s) => { setMissing(!!s.gateScriptMissing); setDenies(!!s.gateDenies); }).catch(() => { /* the server banner owns that story */ });
  }, []);
  useEffect(() => { if (active && !IS_DEMO) read(); }, [active, read]);

  const fix = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.hooksGate(true);
      if (!r.ok) setError(r.error ?? "could not install the gate");
    } catch { setError("could not install the gate"); }
    setBusy(false);
    read();
  }, [read]);

  return missing ? <GateScriptView busy={busy} error={error} denies={denies} onFix={() => void fix()} /> : null;
}
