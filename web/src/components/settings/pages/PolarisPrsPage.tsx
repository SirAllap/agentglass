import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { ScopeControl } from "../scope/ScopeControl.tsx";
import { useScope } from "../scope/useScope.ts";
import { PullRequestsSection } from "../../polaris/PolarisSection.tsx";
import { usePolarisItems } from "../../polaris/usePolaris.ts";
import { prsEmptyNote } from "../../../lib/polarisPrsEmpty.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import "../../agents/agentsView.css";

/** The Polaris pull request list on its own page under Agents: the same list the Agents screen shows in short, at full length. */
export function PolarisPrsPage() {
  const sc = useScope();
  const pol = usePolarisItems(sc.root, !!sc.root);
  const note = sc.root ? prsEmptyNote(pol.settings, pol.items, pol.error) : null;
  const sections: PageSection[] = [
    { id: "polaris-prs", title: "Pull requests", kind: "normal", body: (
      <Section id="polaris-prs" title="Pull requests">
        <div className="agv" style={{ height: "auto", overflow: "visible", background: "transparent" }}>
          {sc.root
            ? <PullRequestsSection root={sc.root} settings={pol.settings} items={pol.items} error={pol.error} onChanged={pol.reload} quietEmpty />
            : <div className="mut">Pick a project to see its pull requests.</div>}
          {note && (note.kind === "off"
            ? <div className="mut">Polaris is off, so it watches nothing. Turn it on in <a href="#" onClick={(e) => { e.preventDefault(); openSettings("polaris"); }}>Polaris</a>.</div>
            : <div className={note.kind === "error" ? "err-line" : "mut"}>{note.text}</div>)}
        </div>
      </Section>
    ) },
  ];
  return (
    <SettingsPage title="Polaris pull requests" purpose="Every open pull request Polaris watches, with why and its next step."
      scopeSlot={<ScopeControl {...sc.controlProps} />} scopeKey={sc.root} sections={sections} />
  );
}
