import type { DoorRowSpec } from "./DoorValueRow.tsx";

/** Flight plan: who flies, what it may spend, what a Preflight reads. */
export const FLIGHT_PLAN_ROWS: DoorRowSpec[] = [
  { id: "flightPlan.enabled", machine: true, kind: "bool", label: "Flight plan", hint: "Shows the view where a plan is written, reviewed and launched." },
  { id: "flightPlan.project.enabled", kind: "bool", label: "Use Flight plan in this project", hint: "Off: no plan is written, no Preflight runs, nothing waits." },
  { id: "flightPlan.pilot", kind: "choice", label: "Who flies this project's plans", hint: "Manual waits at every Go, copilot proposes, and autopilot goes itself.",
    options: [{ value: "manual", label: "Manual" }, { value: "copilot", label: "Copilot" }, { value: "autopilot", label: "Autopilot" }] },
  { id: "flightPlan.held", kind: "bool", label: "Hold this project's flight plans", hint: "On: no new Go and launches are frozen until you turn it off." },
  { id: "flightPlan.autopilot.askOnLarge", kind: "bool", label: "Autopilot asks before Go on a large plan", hint: "On: a large plan waits for a person even on autopilot." },
  { id: "flightPlan.autopilot.askOnSensitive", kind: "bool", label: "Autopilot asks before Go on a sensitive plan", hint: "On: a plan touching security, data or concurrency waits for a person." },
  { id: "flightPlan.maxFlying", kind: "number", min: 1, max: 3, label: "Builders flying at once", hint: "How many launched builders run together, 1 to 3." },
  { id: "flightPlan.builderBase", kind: "choice", label: "Where a builder's worktree is cut from", hint: "Local trunk is what you have here; origin is what the remote has.",
    options: [{ value: "local", label: "Local trunk" }, { value: "remote", label: "Origin" }] },
  { id: "flightPlan.builder.permissions", kind: "choice", label: "Permission mode a launched builder starts in", hint: "Bypass lets it work without dialogs; the sandbox and deny list hold either way.",
    options: [{ value: "default", label: "Default" }, { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Bypass" }] },
  { id: "flightPlan.builder.strongModel", kind: "choice", label: "Model for a sensitive or large plan's builder", hint: "Other plans use the builder role's own model.",
    options: [{ value: "haiku", label: "Haiku" }, { value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }] },
  { id: "flightPlan.mockupGuide", kind: "text", label: "Mockup style guide", hint: "A file the plan's author reads before drawing a mockup; empty means none.", placeholder: "~/notes/mockup-style.md" },
  { id: "flightPlan.preflight.reviews", kind: "list", label: "What a Preflight reviews", hint: "Any of plan, taskDone, pr, comma separated.", placeholder: "plan, pr" },
  { id: "flightPlan.preflight.sizes", kind: "choice", label: "Plan sizes that get a Preflight", hint: "L only, or M and L; other sizes go straight to a builder.",
    options: [{ value: "L", label: "L" }, { value: "ML", label: "M and L" }] },
  { id: "flightPlan.preflight.secondLooks", kind: "number", min: 0, max: 2, label: "Reviews after a fix, per plan", hint: "0 to 2." },
  { id: "flightPlan.preflight.model", kind: "text", label: "Model a Preflight reviews with", hint: "Follows the Reviewer role's model; set the role's model in Orchestration.", placeholder: "" },
  { id: "flightPlan.preflight.costCapUsd", kind: "number", min: 0.01, max: 5, label: "Most one Preflight may spend, in dollars", hint: "Above 0, up to 5." },
  { id: "flightPlan.budget.dailyUsd", kind: "number", min: 0, label: "Most Flight plan may spend in a day, in dollars", hint: "Over it, launches wait until you raise it." },
  { id: "flightPlan.budget.weeklyUsd", kind: "number", min: 0, label: "Most Flight plan may spend in a week, in dollars", hint: "Over it, launches wait until you raise it." },
];

export const CLEANUP_ROWS: DoorRowSpec[] = [
  { id: "cleanup.mode", kind: "choice", label: "After a pull request ends", hint: "What happens to its local leftovers.",
    options: [{ value: "off", label: "Nothing" }, { value: "ask", label: "Ask" }, { value: "atMerge", label: "At merge" }, { value: "auto", label: "Automatic" }] },
  { id: "cleanup.orphanAutoRemove", kind: "bool", label: "Remove Docker orphans by itself", hint: "The images and volumes the sweep lists, when Docker is reachable." },
  { id: "cleanup.evidenceRoots", kind: "list", label: "Folders that hold a pull request's evidence", hint: "Counts a folder whose name starts with the card id; separate with commas.", placeholder: "~/Documents/projects/orbit" },
  { id: "cleanup.otherFolders", kind: "list", label: "Other folders that belong to a card", hint: "Patterns, comma separated.", placeholder: "orbit-*" },
  { id: "cleanup.moveCard", kind: "bool", label: "Move the card too, after a merge", hint: "One more step of the same cleanup plan, through the move door." },
  { id: "cleanup.moveCardStatus", kind: "text", label: "Status a merge's cleanup moves the card to", hint: "As the tracker names it.", placeholder: "Done" },
];

export const SEAT_ROWS: DoorRowSpec[] = [
  { id: "seat.kind", kind: "text", label: "The orchestrator's engine", hint: "Its model goes back to that engine's default.", placeholder: "claude" },
  { id: "seat.model", kind: "text", label: "The orchestrator's model", hint: "Empty: the engine's default.", placeholder: "" },
  { id: "seat.powers", kind: "choice", label: "What the orchestrator may do to other agents", hint: "Speak talks to them, nudge also prods one that stalls, assign also gives work.",
    options: [{ value: "speak", label: "Speak" }, { value: "nudge", label: "Nudge" }, { value: "assign", label: "Assign" }] },
  { id: "seat.change", kind: "bool", label: "Start the orchestrator again on its stored engine", hint: "Turn on to start it again; it goes back off by itself." },
];

export const POLARIS_ROWS: DoorRowSpec[] = [
  { id: "polaris.enabled", kind: "bool", label: "Polaris", hint: "The pull request abilities of the orchestrator." },
  { id: "polaris.botReviewers", kind: "list", label: "Bot logins counted on a head commit", hint: "Reads their review and check summaries; separate logins with commas.", placeholder: "review-bot" },
];

export const TRACKER_ROWS: DoorRowSpec[] = [
  { id: "tracker.choice", kind: "choice", label: "Where this project's cards live", hint: "Auto reads the repository's own signs.",
    options: [{ value: "auto", label: "Auto" }, { value: "clickup", label: "ClickUp" }, { value: "jira", label: "Jira" }] },
  { id: "tracker.clickupWrites", kind: "bool", label: "ClickUp changes on this project", hint: "Off: its ClickUp cards are read-only." },
];

/** Launch defaults a person can type or pick here. The stored shapes with their own editors (roles, launch flags, the policy, presets, budgets, the first-run marks) are read on Inspect. */
export const STORED_ROWS: DoorRowSpec[] = [
  { id: "launch.mode", kind: "choice", label: "Permission mode agents launch in", hint: "What a new agent tab starts in.",
    options: [{ value: "default", label: "Default" }, { value: "acceptEdits", label: "Accept edits" }, { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Bypass" }] },
  { id: "launch.deny", kind: "list", label: "Tools every launched agent is denied", hint: "Comma separated.", placeholder: "WebFetch" },
];
