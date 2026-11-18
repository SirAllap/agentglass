import type { ReactNode } from "react";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section, MoreOptions } from "../shell/Section.tsx";
import { DoorRowList, type DoorSpec } from "./DoorRows.tsx";
import type { ScopeChoice } from "../scope/scopeModel.ts";

/** Flight plan: who flies, what it may spend, what a Preflight reads. Rows by ia.md, copy by pattern.md section 5. */
const MAIN: DoorSpec[] = [
  { id: "flightPlan.enabled", kind: "bool", label: "Flight plan", help: "Shows the view where plans are written and launched." },
  { id: "flightPlan.project.enabled", kind: "bool", label: "Use Flight plan in this project", help: "Off: no plan is written and no Preflight runs." },
  { id: "flightPlan.autopilot.askOnLarge", kind: "bool", label: "Autopilot asks before Go on a large plan", help: "A large plan waits for you, even on autopilot." },
  { id: "flightPlan.autopilot.askOnSensitive", kind: "bool", label: "Autopilot asks before Go on a sensitive plan", help: "A plan touching security or data waits for you." },
  { id: "flightPlan.maxFlying", kind: "number", min: 1, max: 3, label: "Builders flying at once", help: "How many launched builders may run together, 1 to 3." },
  { id: "flightPlan.mockupGuide", kind: "text", label: "Mockup style guide", help: "A file the plan's author reads before drawing a mockup.", placeholder: "~/notes/mockup-style.md" },
  { id: "flightPlan.preflight.reviews", kind: "list", label: "What a Preflight reviews", help: "Any of plan, taskDone, pr, with commas between.", placeholder: "plan, pr" },
  { id: "flightPlan.preflight.sizes", kind: "choice", label: "Plan sizes that get a Preflight", help: "Other sizes go straight to a builder.",
    options: [{ value: "L", label: "L" }, { value: "ML", label: "M and L" }] },
  { id: "flightPlan.preflight.secondLooks", kind: "number", min: 0, max: 2, label: "Reviews after a fix, per plan", help: "How many more reviews a fixed plan gets, 0 to 2." },
  { id: "flightPlan.preflight.model", kind: "text", label: "Model a Preflight reviews with", help: "Empty follows the Reviewer role's model.", placeholder: "" },
  { id: "flightPlan.preflight.costCapUsd", kind: "number", min: 0.01, max: 5, label: "Most one Preflight may spend, in dollars", help: "Above 0, up to 5." },
  { id: "flightPlan.budget.dailyUsd", kind: "number", min: 0, label: "Most Flight plan may spend in a day, in dollars", help: "Over it, launches wait until you raise it." },
  { id: "flightPlan.budget.weeklyUsd", kind: "number", min: 0, label: "Most Flight plan may spend in a week, in dollars", help: "Over it, launches wait until you raise it." },
];
const MORE: DoorSpec[] = [
  { id: "flightPlan.pilot", kind: "choice", label: "Who flies this project's plans", help: "Manual waits at every Go; autopilot goes by itself.",
    options: [{ value: "manual", label: "Manual" }, { value: "copilot", label: "Copilot" }, { value: "autopilot", label: "Autopilot" }] },
  { id: "flightPlan.held", kind: "bool", label: "Hold this project's flight plans", help: "On: no new Go, and launches stay frozen." },
  { id: "flightPlan.builderBase", kind: "choice", label: "Where a builder's worktree is cut from", help: "Local trunk, or what the remote has.",
    options: [{ value: "local", label: "Local trunk" }, { value: "remote", label: "Origin" }] },
  { id: "flightPlan.builder.permissions", kind: "choice", label: "Permission mode a launched builder starts in", help: "The sandbox and deny list hold in every mode.",
    options: [{ value: "default", label: "Default" }, { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Bypass" }] },
  { id: "flightPlan.builder.strongModel", kind: "choice", label: "Model for a sensitive or large plan's builder", help: "Other plans use the builder role's own model.",
    options: [{ value: "haiku", label: "Haiku" }, { value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }] },
];

export function FlightPlanPage({ root, scopeSlot, choice }: { root: string; scopeSlot?: ReactNode; choice?: ScopeChoice }) {
  const sections: PageSection[] = [
    { id: "flightPlan", title: "Flight plan", kind: "normal",
      body: <Section id="flightPlan" title="Flight plan"><DoorRowList title="Flight plan" specs={MAIN} root={root} choice={choice} /></Section> },
    { id: "more", title: "More options", kind: "more",
      body: <MoreOptions><DoorRowList title="More options" specs={MORE} root={root} choice={choice} /></MoreOptions> },
  ];
  return <SettingsPage title="Flight plan" purpose="Who flies a plan, what it may spend, and what a Preflight reads." scopeSlot={scopeSlot} scopeKey={root} sections={sections} />;
}
