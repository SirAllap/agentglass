import { useState } from "react";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { api } from "../../../lib/api.ts";
import { openExternal } from "../../../lib/externalUrl.ts";
import { buildBundle, issueUrl, KNOWN_SETTING_KEYS } from "../../../../../shared/reportBundle.ts";

const REPO = "SirAllap/agentglass";

/** Known settings that are switched on, by name. Only keys on the allowlist are
 *  read, so a key that embeds a repo name is never even looked at. */
function enabledSettingNames(): string[] {
  const out: string[] = [];
  try {
    for (const k of KNOWN_SETTING_KEYS) {
      if (["1", "true", "on"].includes(localStorage.getItem(k) ?? "")) out.push(k);
    }
  } catch { /* storage blocked: report no settings */ }
  return out;
}

export function ReportProblemRow() {
  const [text, setText] = useState<string | null>(null);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const build = async () => {
    try {
      const r = await api.reportRaw();
      setRaw(r);
      setText(buildBundle({ ...r, enabledSettings: enabledSettingNames() }));
      setNote("");
    } catch { setNote("Could not read the diagnostics."); }
  };
  return (
    <SettingRow kind="control" label="Report a problem"
      help="Builds a diagnostic with paths and secrets removed; you read it first."
      control={<span className="flex flex-col gap-2 items-end">
        <Button size="compact" onClick={() => void build()}>Build the report</Button>
        {text !== null && <>
          <textarea readOnly className="agx-input" rows={10} cols={60} value={text} aria-label="Diagnostic text" />
          <span className="flex gap-2">
            <Button size="compact" onClick={() => void navigator.clipboard.writeText(text).then(() => setNote("Copied."), () => setNote("The clipboard refused that."))}>Copy</Button>
            <Button size="compact" onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}); openExternal(issueUrl(REPO, { version: raw.version, commit: raw.commit, os: raw.os }), { machine: true }); }}>Open a GitHub issue</Button>
          </span>
        </>}
        {note && <span role="status">{note}</span>}
      </span>} />
  );
}
