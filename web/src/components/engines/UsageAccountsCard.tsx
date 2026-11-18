import { useCallback, useEffect, useState } from "react";
import { api, type OwnAccountsRead } from "../../lib/api.ts";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";
import { SettingRow as ShellRow } from "../settings/shell/SettingRow.tsx";
import { accountLines } from "../../lib/usageAccountsView.ts";
import type { ProviderUsage } from "../../../../shared/types.ts";
import type { UsageProviderId } from "../../../../shared/orchestration.ts";

/**
 * Accounts per provider: each with its own gauge, and an Add account row that
 * takes a label and one of the offered source names. Only the name of a source
 * is ever stored or shown; no credential passes through here.
 */
const PROVIDERS: { id: UsageProviderId; label: string }[] = [{ id: "anthropic", label: "Claude" }, { id: "codex", label: "Codex" }];

function AddRow({ provider, sources, onAdded }: { provider: UsageProviderId; sources: { id: string; label: string }[]; onAdded: () => void }) {
  const [label, setLabel] = useState("");
  const [source, setSource] = useState(sources[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    const r = await api.ownAccountAdd(provider, label, source || undefined).catch(() => null);
    if (!r?.ok) { setErr(r?.error ?? "Could not reach the server."); return; }
    setErr(null); setLabel(""); onAdded();
  };
  return (
    <ShellRow kind="control" label="Add account" help={err ?? "Names one more plan and where its login is read from."}
      control={<div className="flex items-center gap-2">
        <input className={INPUT} style={INPUT_STYLE} value={label} placeholder="Label, e.g. Orbit team" aria-label="Account label" maxLength={40}
          onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <Select value={source} align="right" options={sources.map((s) => ({ value: s.id, label: s.label }))} onChange={setSource} />
        <Button onClick={() => void add()} disabled={!label.trim()}>Add</Button>
      </div>} />
  );
}

export function UsageAccountsCard() {
  const [read, setRead] = useState<OwnAccountsRead | null>(null);
  const [rows, setRows] = useState<ProviderUsage[]>([]);
  const load = useCallback(() => {
    void api.ownAccounts().then(setRead).catch(() => setRead(null));
    void api.providerUsage().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  if (!read) return <div role="status" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>Reading the accounts…</div>;
  return (
    <>
      {PROVIDERS.map((p) => (
        <div key={p.id}>
          {accountLines(rows, read.accounts, p.id, p.label).map((a) => (
            <ShellRow key={a.id} kind="control" label={`${p.label}: ${a.label}`} help={`${a.gauge}${a.source ? ` · source ${a.source}` : ""}`}
              control={a.id === "default" ? <span className="text-[12px]" style={{ color: "var(--text2)" }}>Default</span>
                : <Button onClick={() => void api.ownAccountRemove(p.id, a.id).then(load)}>Remove</Button>} />
          ))}
          <AddRow provider={p.id} sources={read.sources[p.id] ?? []} onAdded={load} />
        </div>
      ))}
    </>
  );
}
