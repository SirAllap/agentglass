/*
 * Settings > Agents > Polaris: the page the Polaris view lives on now, with
 * the project choice it reads for. The view itself is unchanged: this only
 * gives it a home of its own, beside Orchestration instead of inside it.
 */
import { useEffect, useState } from "react";
import { SettingsCard } from "../SettingsKit.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { Button, LINE } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { FlowIcon } from "../settingsNavIcons.tsx";
import { api } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { openingScope, recallScope, rememberScope } from "../orchestration/orchestrationCopy.ts";
import { OrchSeg } from "../orchestration/OrchKit.tsx";
import { PolarisView } from "./PolarisView.tsx";

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };
const baseName = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

export function PolarisPane() {
  const [root, setRoot] = useState(() => recallScope(storage()) ?? "");
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void api.projects().then((r) => {
      if (!live) return;
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      setProjects(ws);
      // The same "the project the app shows" rule as Orchestration: never a choice nobody made,
      // and a remembered project that is gone falls back to All projects.
      setRoot((cur) => openingScope(cur, ws, null));
    }).catch(() => { /* the view says it could not read; the choice stays All projects */ });
    return () => { live = false; };
  }, []);

  const pick = (next: string) => { setRoot(next); rememberScope(storage(), next); };

  return (
    <div className="agx-orch">
      {/* The same chips, in the same row (same classes, inset and rule) as Orchestration's scope bar: one control for "whose setting is this", in one place. */}
      <div className="agx-flow-scope agx-settings-x"
        style={{ borderBottom: LINE, marginTop: "calc(var(--agx-pin-gap, 12px) - var(--agx-page-gap, 18px))", marginBottom: 12 }}>
        <OrchSeg label="Settings for" value={root} onChange={pick}
          options={[{ id: "", label: "All projects", title: "The setting every project without its own uses" },
            ...projects.map((r) => ({ id: r, label: baseName(r), title: r }))]} />
        <span className="text-[12px]" style={{ color: "var(--text3)" }}>
          {root ? `Showing ${baseName(root)}. A project without its own follows All projects.` : "All projects: the setting every project without its own uses."}
        </span>
      </div>
      <PolarisView root={root} />

      {/* The way back: Orchestration keeps the rules, and this page is its sister. */}
      <SettingsCard title="Orchestration" icon={<FlowIcon size={ICON.sm} />}
        desc="The drawing of who does what, the rules that change it for a while, and what a worker may do.">
        <SettingRow agentExempt label="Orchestration settings"
          hint="The rules live there; this page only decides what Polaris watches and what it may do."
          actions={<Button onClick={() => openSettings("orchestration")}>Open Orchestration settings</Button>} />
      </SettingsCard>
    </div>
  );
}
