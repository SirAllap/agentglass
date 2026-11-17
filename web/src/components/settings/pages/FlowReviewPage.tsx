import type { ReactNode } from "react";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section, MoreOptions } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { DoorRowList, type DoorSpec } from "./DoorRows.tsx";

/** Flow & review: the flow, the orchestrator, who reviews, and Polaris. Rows by ia.md, copy by pattern.md section 5. */
const FLOW: DoorSpec[] = [
  { id: "flow.autoContinue", kind: "bool", label: "Auto-continue to next flow role", help: "The next role starts in the same tab when a worker ends." },
  { id: "flow.enforce", kind: "bool", label: "Hold workers to the flow", help: "A step is refused until the one before it is done." },
  { id: "flow.sessionStart.move", kind: "bool", label: "Move the card at session start", help: "A worker's first turn moves its card." },
  { id: "flow.sessionStart.moveStatus", kind: "text", label: "Status to move it to", help: "The status, as the tracker names it.", placeholder: "In progress" },
  { id: "flow.nextCard.enabled", kind: "bool", label: "Next card: scout a saved filter's members", help: "Scouts the next card of a saved filter by itself." },
  { id: "flow.notifyPrReviews", kind: "bool", label: "Notify the project lead of PR reviews", help: "Tells the lead when a bot or person reviews." },
];
const SEAT: DoorSpec[] = [
  { id: "seat.kind", kind: "text", label: "The orchestrator's engine", help: "Its model goes back to that engine's default.", placeholder: "claude" },
  { id: "seat.model", kind: "text", label: "The orchestrator's model", help: "Empty uses the engine's default.", placeholder: "" },
  { id: "seat.powers", kind: "choice", label: "What the orchestrator may do to other agents", help: "Speak talks, nudge prods a stalled one, assign gives work.",
    options: [{ value: "speak", label: "Speak" }, { value: "nudge", label: "Nudge" }, { value: "assign", label: "Assign" }] },
  { id: "seat.change", kind: "bool", label: "Start the orchestrator again on its stored engine", help: "Starts it again, then turns itself off." },
];
export const POLARIS: DoorSpec[] = [
  { id: "polaris.enabled", kind: "bool", label: "Polaris", help: "Lets the orchestrator watch and act on pull requests." },
  { id: "polaris.botReviewers", kind: "list", label: "Bot logins counted on a head commit", help: "Their review and check summaries are read.", placeholder: "review-bot" },
];
/** Machine tuning that keeps this page until step 4 moves it to Advanced. */
const TUNING: DoorSpec[] = [
  { id: "flow.nextCard.filterId", kind: "text", label: "The saved filter to read, by its id", help: "For a filter the picker cannot name.", placeholder: "" },
  { id: "flow.nextCard.cap", kind: "number", min: 1, max: 5, label: "Most scouts running at once for this filter", help: "Stops one filter feeding too many scouts." },
  { id: "flow.notifyPrReviews.bots", kind: "list", label: "Extra logins that count as a bot's review", help: "Add a review bot that appears in your PRs.", placeholder: "review-bot" },
];

export interface FlowReviewPageProps {
  root: string;
  scopeSlot?: ReactNode;
  /** The existing drawing of who does what, with its presets and conditions. */
  flowSlot?: ReactNode;
  /** Opens the Polaris page (assisted setup, doors, presets, limits). */
  onOpenPolaris: () => void;
  /** Machine rows that are not stored door rows. */
  machineSlot?: ReactNode;
  onOpenConditions: () => void;
  onOpenReviewer: () => void;
}

export function FlowReviewPage(p: FlowReviewPageProps) {
  const sections: PageSection[] = [
    ...(p.flowSlot ? [{ id: "canvas", title: "Flow", kind: "normal" as const, body: <Section id="canvas" title="Flow" intro="Who does what, on which engine.">{p.flowSlot}</Section> }] : []),
    { id: "session", title: "Session and cards", kind: "normal", body: <Section id="session" title="Session and cards"><DoorRowList title="Session and cards" specs={FLOW} root={p.root} /></Section> },
    { id: "orchestrator", title: "Orchestrator", kind: "normal", body: <Section id="orchestrator" title="Orchestrator"><DoorRowList title="Orchestrator" specs={SEAT} root={p.root} /></Section> },
    { id: "review", title: "Review", kind: "normal",
      body: (
        <Section id="review" title="Review" intro="Set on the reviewing block of the flow.">
          <SettingRow kind="link" agentExempt label="Conditions" help="Rules that change which engine a block uses for a while." linkText="Open on the flow" onOpen={p.onOpenConditions} />
          <SettingRow kind="link" settingId="orchestration.review.who" label="Who reviews and checks" help="One answer per project." linkText="Open at the reviewing block" onOpen={p.onOpenReviewer} />
          <SettingRow kind="link" settingId="orchestration.review.rounds" label="Most rounds before it stops" help="Caps the review loop, 1 to 6." linkText="Open at the reviewing block" onOpen={p.onOpenReviewer} />
          <SettingRow kind="link" settingId="orchestration.review.second" label="Second reviewer on another model" help="A second reader of the same diff." linkText="Open at the reviewing block" onOpen={p.onOpenReviewer} />
        </Section>
      ) },
    { id: "polaris", title: "Polaris", kind: "normal",
      body: <Section id="polaris" title="Polaris" intro="What the orchestrator watches on pull requests.">
          <SettingRow kind="link" agentExempt label="Polaris settings" help="What it watches, what it may do alone, and its limits." linkText="Open Polaris settings" onOpen={p.onOpenPolaris} /></Section> },
    { id: "more", title: "More options", kind: "more", body: <MoreOptions><DoorRowList title="More options" specs={TUNING} root={p.root} />{p.machineSlot}</MoreOptions> },
  ];
  return <SettingsPage title="Flow & review" purpose="How work moves between agents, who reviews it, and what Polaris watches." scopeSlot={p.scopeSlot} scopeKey={p.root} sections={sections} />;
}
