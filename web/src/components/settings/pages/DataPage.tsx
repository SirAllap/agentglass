import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { DownloadButton, SELECT_BOX } from "../../SettingsKit.tsx";
import { LogDigestSection } from "../../SettingsModal.tsx";
import { MemoryReserveCard } from "../../MemoryReserveCard.tsx";
import { DangerAction, instantSave } from "../save/index.ts";
import { api } from "../../../lib/api.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { setting, subscribeSettings } from "../../../lib/settingsRegistry.ts";
import { DISK_WARN_CHOICES, DISK_WARN_DEFAULT, diskWarnPct } from "../../../lib/diskWarnPref.ts";
import type { PageCtx } from "./ctx.ts";

const EXPORTS = [
  { label: "Events (CSV)", help: "One row per event, for a spreadsheet.", href: () => api.exportUrl("csv"), file: "agentglass-events.csv" },
  { label: "Events (JSON)", help: "Full payloads, for scripting.", href: () => api.exportUrl("json"), file: "agentglass-events.json" },
  { label: "Daily totals (CSV)", help: "One row per day, back past what history keeps.", href: () => api.exportUrl("csv", "daily"), file: "agentglass-daily.csv" },
  { label: "Daily totals (JSON)", help: "The same days, with where history was trimmed.", href: () => api.exportUrl("json", "daily"), file: "agentglass-daily.json" },
  { label: "Skills catalog (Markdown)", help: "Every skill your agents have available.", href: () => api.skillsExportUrl(), file: "agentglass-skills.md" },
] as const;

/** System > Data & privacy. Retention, keyring and the two caches are read-outs: they move to Inspect in step 4. */
export function DataSettingsPage({ c }: { c: PageCtx }) {
  const diskWarn = useSyncExternalStore(subscribeSettings, diskWarnPct, () => DISK_WARN_DEFAULT);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setResult(null); }, [c.open]);
  const erase = async () => {
    const r = await api.privacyErase().catch(() => null);
    setResult(r?.ok ? { ok: true, text: `Erased ${r.events ?? 0} events and ${r.sessions ?? 0} sessions.` } : { ok: false, text: r?.error ?? "That did not work. Nothing was erased." });
  };
  return (
    <SettingsPage
      title="Data & privacy"
      purpose="See what the app keeps on this machine, take it out, or erase it."
      sections={[
        {
          id: "activity-log", title: "Activity log", kind: "normal",
          body: (
            <Section id="activity-log" title="Activity log">
              <SettingRow kind="link" label="Activity log" help="Every change this app made, newest first." linkText="Open" onOpen={() => openSettings("log")} />
            </Section>
          ),
        },
        {
          id: "disk-space", title: "Disk space", kind: "normal",
          body: (
            <Section id="disk-space" title="Disk space">
              <SettingRow kind="control" settingId="prefs.diskWarn" label="Warn when free disk is under" help="Shows a quiet badge on the machine panel and deletes nothing."
                control={
                  <Select align="right" style={SELECT_BOX} value={String(diskWarn)}
                    onChange={(v) => instantSave(diskWarn, Number(v), (n) => { setting("prefs.diskWarn").set(n); })}
                    options={DISK_WARN_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? "Off" : `${n} %` }))} />
                } />
            </Section>
          ),
        },
        {
          id: "take-out", title: "Take your data out", kind: "normal",
          body: (
            <Section id="take-out" title="Take your data out" intro="With a project open, these hold that project's rows.">
              {EXPORTS.map((e) => (
                <SettingRow key={e.label} kind="control" label={e.label} help={e.help}
                  control={<DownloadButton href={e.href()} download={e.file}>Download</DownloadButton>} />
              ))}
            </Section>
          ),
        },
        { id: "memory", title: "Memory reserve", kind: "normal", body: <div data-section="memory"><MemoryReserveCard open={c.open} nonce={0} show="all" /></div> },
        { id: "digest", title: "Log digest", kind: "normal", body: <div data-section="digest"><LogDigestSection d={c.logDigest} /></div> },
        {
          id: "danger", title: "Danger zone", kind: "danger",
          body: (
            <DangerZone>
              <SettingRow kind="control" label="Erase local history" help="Removes events, sessions and daily totals; settings and tokens stay."
                control={<DangerAction label="Erase history" onConfirm={() => erase()} />} />
              {result && <div role={result.ok ? "status" : "alert"} className="px-3 py-2 text-[12px]" style={{ color: result.ok ? "var(--success-ink)" : "var(--error-ink)" }}>{result.text}</div>}
            </DangerZone>
          ),
        },
      ]}
    />
  );
}
