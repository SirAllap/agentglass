import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { pushSaveToast } from "../save/index.ts";
import { FlagsTable, ValueView } from "./ValueView.tsx";
import { INSPECT_ROWS, INSPECT_SECTIONS, factText } from "./inspectRows.ts";

const FLAGS_PREFIX = "launch.flags.";
const FLAGS_SUFFIX = " launch flags per permission mode";

type Read = { state: "loading" } | { state: "ok"; text: string; raw: unknown } | { state: "failed" };

/** Inspect: what the app reports about itself. Read-only fact rows with a Copy button; nothing here is editable. */
export function InspectSettingsPage() {
  const [vals, setVals] = useState<Record<string, Read>>({});
  const load = useCallback(() => {
    setVals(Object.fromEntries(INSPECT_ROWS.map((r) => [r.id, { state: "loading" } as Read])));
    for (const r of INSPECT_ROWS) {
      void api.settingAtGlobal(r.id).then((x) => (x?.ok ? { state: "ok", text: factText(x.value), raw: x.value } : { state: "failed" }) as Read)
        .catch(() => ({ state: "failed" }) as Read)
        .then((v) => setVals((s) => ({ ...s, [r.id]: v })));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text).then(() => pushSaveToast("Copied", () => undefined)).catch(() => undefined); } catch { /* clipboard blocked: nothing to do */ }
  };

  const sections: PageSection[] = INSPECT_SECTIONS.map((title) => ({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    kind: "normal",
    body: (
      <Section id={title.toLowerCase().replace(/[^a-z0-9]+/g, "-")} title={title}>
        {INSPECT_ROWS.filter((r) => r.section === title && !r.id.startsWith(FLAGS_PREFIX)).map((r) => {
          const v = vals[r.id] ?? { state: "loading" };
          if (v.state === "ok") return <SettingRow key={r.id} settingId={r.id} kind="fact" label={r.label} help={r.help} value={v.text} view={<ValueView value={v.raw} />} onCopy={copy} />;
          return (
            <SettingRow key={r.id} settingId={r.id} kind="link" label={r.label} help={v.state === "loading" ? r.help : "This value could not be read. Nothing was changed."}
              linkText={v.state === "loading" ? "Reading…" : "Retry"} onOpen={v.state === "loading" ? undefined : load} />
          );
        })}
        {title === "Launch" && <FlagsTable rows={INSPECT_ROWS.filter((r) => r.id.startsWith(FLAGS_PREFIX)).map((r) => ({ engine: r.label.replace(FLAGS_SUFFIX, ""), value: (vals[r.id] as { raw?: unknown } | undefined)?.raw }))} />}
      </Section>
    ),
  }));

  return (
    <SettingsPage title="Inspect" purpose="What the app reports about itself. Nothing here is editable."
      scopeSlot={<p data-banner className="text-[12px]" style={{ color: "var(--text2)" }}>Read once when the app starts. Change a value on its own page, then restart.</p>}
      sections={sections} />
  );
}
