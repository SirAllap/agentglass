/*
 * Settings › Task trackers: one row per tracker the Cards tab could read, and
 * the reason it is or is not doing so.
 *
 * The phone cannot connect a tracker (see use-tracks-work.ts), so this list is
 * a diagnosis and never a setup: each row says what the computer told us, in
 * words, because a missing Cards tab with no explanation reads as a bug in the
 * app. Jira is listed on purpose — somebody who uses it is looking for it, and
 * "not supported yet" is a better answer than a screen that never mentions it.
 */
import { PROVIDERS, type ProviderStatus } from "../../../shared/providers.ts";
import { setUp } from "./taskProviders.ts";

export type TrackerBadge = "on" | "off" | "soon";

export interface TrackerRow {
  id: string;
  title: string;
  badge: TrackerBadge;
  reason: string;
}

const WHERE = "Connect it on the computer (Settings › Integrations).";

export function trackerRows(statuses: ProviderStatus[] | null | undefined): TrackerRow[] {
  // ClickUp first: it is the one with a board, and the order the mocks show.
  const order = (id: string): number => (id === "clickup" ? 0 : 1);
  const specs = PROVIDERS.filter((p) => p.kind === "task").sort((a, b) => order(a.id) - order(b.id));
  const rows: TrackerRow[] = specs.map((spec) => {
    const row = (badge: TrackerBadge, reason: string): TrackerRow => ({ id: spec.id, title: spec.title, badge, reason });
    const s = statuses?.find((p) => p.id === spec.id);
    if (!s) return row("off", statuses ? WHERE : "Waiting for the computer to answer.");
    // "Set up" is the Cards tab's own rule (a failing tracker still counts).
    if (setUp(s.state)) {
      return row("on", s.state === "error" ? `${s.detail ?? "It is connected and failing."} Fix it on the computer.` : s.detail ?? "Connected.");
    }
    if (s.state === "missing-tool") return row("off", `The ${spec.dep ?? spec.id} tool is not installed on the computer.`);
    return row("off", `Not connected. ${WHERE}`);
  });
  rows.push({
    id: "jira", title: "Jira", badge: "soon",
    reason: "Not supported by agentglass yet, so there is no Cards tab for it.",
  });
  return rows;
}

/** The line under "Task trackers" in Settings. */
export function trackersSummary(statuses: ProviderStatus[] | null | undefined): string {
  if (!statuses) return "Which trackers feed the Cards tab";
  const on = trackerRows(statuses).filter((r) => r.badge === "on").map((r) => r.title);
  return on.length ? `${on.join(", ")} connected · Cards tab on` : "None connected · Cards tab hidden";
}
