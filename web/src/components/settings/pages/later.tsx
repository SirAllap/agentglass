import { CardTrackerSection } from "../../SettingsModal.tsx";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import type { PageCtx } from "./ctx.ts";
import { OrchestrationPane } from "../../orchestration/OrchestrationPane.tsx";
import { FlightPlanSettings } from "../../flightPlan/FlightPlanSettings.tsx";

/* Pages the new nav has and the old one did not. Each one is a stand-in until
   the step that builds it: it holds no setting of its own (every stored key
   keeps its one home on the page it has today) and says where that home is.
   A link row is not a second setting, so each is `agentExempt`. */

/** Roles & limits: the orchestrator, the roles, memory and every limit, for one project. */
export function WorkersSettingsPage(_: { c?: PageCtx }) {
  return <OrchestrationPane part="limits" />;
}

/** Flight plan: its 20 stored keys on their own page. */
export function FlightPlanSettingsPage(_: { c?: PageCtx }) {
  return <FlightPlanSettings />;
}

/** Card tracker: the section Tasks and Jira each show today. */
export function TrackerSettingsPage() {
  const sections: PageSection[] = [
    { id: "tracker", title: "Card tracker", kind: "normal", body: <Section id="tracker" title="Card tracker"><CardTrackerSection /></Section> },
  ];
  return <SettingsPage title="Card tracker" purpose="Choose where a card id in a branch or pull request is looked up." sections={sections} />;
}
