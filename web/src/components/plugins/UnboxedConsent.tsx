import { useState } from "react";
import type { PublicPlugin } from "../../../../shared/types.ts";
import { unboxedControl } from "../../lib/pluginBoxState.ts";
import { api } from "../../lib/api.ts";
import { ShieldIcon } from "../settingsNavIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";

/**
 * The per-plugin consent to run without a box, drawn on the card of the
 * plugin it concerns. What it says and when it exists is `unboxedControl`'s
 * (pure, tested); this only asks the server and reports a refusal in its own
 * words, never an exception's.
 */
export function UnboxedConsent({ plugin, envAllowsAll, onChanged }: {
  plugin: PublicPlugin; envAllowsAll: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const control = unboxedControl(plugin, envAllowsAll);
  if (!control) return null;

  const grant = control.kind === "allow";
  const tint = grant ? "var(--warning)" : "var(--error)";
  const change = async () => {
    setBusy(true);
    setError(null);
    const r = await api.pluginAllowUnboxed(plugin.name, grant);
    setBusy(false);
    if (!r.ok) setError(r.error ?? "the change was not made");
    onChanged();
  };

  return (
    <div role="group" aria-label="Run without a box" className="mt-1.5 px-3 py-2 rounded-lg" style={{
      background: `color-mix(in srgb, ${tint} 9%, transparent)`,
      border: EDGE,
    }}>
      <div className="flex items-start gap-2 min-w-0">
        <span className="shrink-0 mt-px flex" style={{ color: tint }}><ShieldIcon size={ICON.sm} /></span>
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{control.text}</p>
      </div>
      <div className="flex items-center justify-end gap-2 mt-1.5">
        {error && <span className="text-[11px] min-w-0" style={{ color: "var(--error)" }}>{error}</span>}
        <Button size="compact" tone={grant ? undefined : "danger"} pending={busy} onClick={change}>{control.button}</Button>
      </div>
    </div>
  );
}
