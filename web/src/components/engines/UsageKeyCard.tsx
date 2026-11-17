import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { USAGE_KEY_STEPS } from "../../lib/usageKeyGuide.ts";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { StatusBadge } from "../SettingsKit.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { SettingRow as ShellRow } from "../settings/shell/SettingRow.tsx";
import type { ProviderUsage } from "../../../../shared/types.ts";
import { keyStatusChip, lastReading } from "../../lib/opencodeKey.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { usePageLoading } from "../settings/shell/pageLoad.tsx";

/**
 * The optional console key, as a field on the engines page.
 *
 * Nothing is ever read back: the answer is whether one is stored, so the field
 * starts empty whether or not a key exists and the only way to replace one is
 * to paste a new one. That is the same rule credentials.ts keeps for the
 * provider tokens, and the reason there is no "show" button.
 */
export function useOpenCodeKey() {
  const [set, setSet] = useState<boolean | null>(null);
  const read = useCallback(() => {
    void api.openCodeKey().then((r) => setSet(!!r.set)).catch(() => setSet(null));
  }, []);
  useEffect(() => { read(); }, [read]);
  return { set, setSet };
}

function KeyGuide({ open }: { open: boolean }) {
  return (
    <SettingRow agentExempt label="Where the key comes from"
      hint="The permission list is the part people get wrong."
      detail={{
        summary: "How to create the key",
        defaultOpen: open,
        body: (
          <div className="agx-steps">
            {USAGE_KEY_STEPS.map((step, i) => (
              <SettingRow key={step.title} agentExempt hint={step.what}
                label={<span className="agx-step"><i aria-hidden>{i + 1}</i>{step.title}</span>} />
            ))}
          </div>
        ),
      }} />
  );
}

export function UsageKeyFields({ set, setSet, onChanged }: {
  set: boolean | null;
  setSet: (set: boolean) => void;
  onChanged?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const r = await api.setOpenCodeKey(draft.trim()).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setNote(r?.error ?? "That did not save."); return; }
    setDraft("");
    setNote(null);
    setSet(true);
    onChanged?.();
  };
  const clear = async () => {
    setBusy(true);
    const r = await api.clearOpenCodeKey().catch(() => null);
    setBusy(false);
    if (!r?.ok) { setNote(r?.error ?? "That did not clear."); return; }
    setNote(null);
    setSet(false);
    onChanged?.();
  };

  return (
    <>
      <KeyGuide open={set !== true} />
      <SettingRow label="OpenCode usage key"
        hint="Read when agentglass starts, when the panel opens and when you press its refresh button (never more than once in ten minutes). Never shown again after it is saved."
        below={
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <input id="opencode-usage-key" aria-label="OpenCode usage key" type="password" value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={set ? "Paste a new key to replace the stored one" : "Paste the key"} spellCheck={false} autoComplete="off"
              className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            <div className="agx-sform-actions">
              <Button type="submit" tone="primary" pending={busy} disabled={!draft.trim()}>Save key</Button>
              {set && <Button onClick={() => void clear()}>Clear</Button>}
            </div>
            {note && <div role="alert" className="agx-field-e">{note}</div>}
          </form>
        } />
    </>
  );
}

/**
 * The OpenCode Go card on Usage & budgets: the key, the guide, the console
 * calibration, and the last reading with its source. The key itself is typed
 * once, in the OpenCode tile on Agent engines, next to the engine it belongs to.
 */
export function OpenCodeGoCard() {
  const { set, setSet } = useOpenCodeKey();
  const [row, setRow] = useState<ProviderUsage | null>(null);
  // `row` stays null when OpenCode has no reading, so "read once" is its own flag.
  const [readOnce, setReadOnce] = useState(false);
  usePageLoading("opencode/usage", !readOnce);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.providerUsage()
      .then((rows) => setRow(rows.find((r) => r.provider === "opencode") ?? null))
      .catch(() => setRow(null))
      .finally(() => setReadOnce(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const calibrate = async () => {
    setBusy(true);
    setNote(null);
    const r = await api.refreshOpenCodeUsage(true).catch(() => null);
    setBusy(false);
    if (!r) { setNote("The console could not be read."); return; }
    if (!r.available) setNote(r.note ?? "The console could not be read.");
    load();
  };

  const chip = keyStatusChip(set, row);
  const last = lastReading(row);
  return (
    <>
      <ShellRow kind="control" agentExempt label="OpenCode Go usage key" help="The key lives with its engine in Agent engines."
        control={<span className="flex items-center gap-2"><StatusBadge tone={chip.tone}>{chip.text}</StatusBadge>
          <Button onClick={() => openSettings("engines")}>{set ? "Manage in Agent engines" : "Add in Agent engines"}</Button></span>} />
      <ShellRow kind="control" agentExempt label="Last reading" help={row?.usageNote || (!row?.available && row?.note) || "The newest plan numbers agentglass has."}
        control={<span className="flex items-center gap-2">
          <StatusBadge tone={last.tone}>{last.value}</StatusBadge>
          {last.source && <span className="chip text-[10px] t-dim">{last.source}</span>}
          {last.age && <span className="text-[10px] t-dim">{last.age}</span>}
        </span>} />
      <ShellRow kind="control" agentExempt label="Read the console now" help="Reads the console once, with the stored key or your sign-in."
        control={<Button onClick={() => void calibrate()} pending={busy}>Read the console now</Button>} />
      {note && <div role="alert" className="agx-field-e px-3 pb-2.5">{note}</div>}
    </>
  );
}
