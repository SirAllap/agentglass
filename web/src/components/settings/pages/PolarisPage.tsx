import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { ScopeControl } from "../scope/ScopeControl.tsx";
import { useScope } from "../scope/useScope.ts";
import { PolarisView } from "../../polaris/PolarisView.tsx";
import { DoorRowList } from "./DoorRows.tsx";
import { POLARIS } from "./FlowReviewPage.tsx";
import { openSettings } from "../../../lib/openSettings.ts";

/** Polaris: what the orchestrator watches on pull requests and what it may do, on the page shell like every other page. */
export function PolarisPage() {
  const sc = useScope();
  const sections: PageSection[] = [
    { id: "polaris", title: "Polaris", kind: "normal", body: <Section id="polaris" title="Polaris"><div className="agx-orch"><PolarisView root={sc.root} /></div><DoorRowList title="Polaris" specs={POLARIS} root={sc.root} /></Section> },
    { id: "orchestration", title: "Orchestration", kind: "normal", body: (
      <Section id="orchestration" title="Orchestration">
        <SettingRow kind="link" agentExempt label="Orchestration settings" help="The rules live there; Polaris only decides what it watches." linkText="Open Orchestration settings" onOpen={() => openSettings("orchestration")} />
      </Section>
    ) },
  ];
  return (
    <SettingsPage title="Polaris" purpose="Choose what the orchestrator watches on pull requests and what it may do."
      scopeSlot={<ScopeControl {...sc.controlProps} />} scopeKey={sc.root} sections={sections} />
  );
}
