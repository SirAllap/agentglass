import type { NotifyTarget } from "../../../shared/notifyPayload.ts";
import type { SystemNote } from "./sysNotify.ts";

/** A target as the router's destination. A `url` opens in the agentglass browser (or its own view, for a Jira issue or a PR). */
export function gotoOfTarget(t: NotifyTarget): NonNullable<SystemNote["goto"]> | null {
  switch (t.kind) {
    case "pr": return { kind: "pr", repo: t.repo, number: t.number };
    case "pane": return { kind: "pane", pane: t.pane };
    case "file": return { kind: "file", root: t.root, path: t.path };
    case "card": return { kind: "card", id: t.id, label: t.label, ...(t.tracker ? { tracker: t.tracker } : null) };
    case "url": return { kind: "web", url: t.url };
  }
}
