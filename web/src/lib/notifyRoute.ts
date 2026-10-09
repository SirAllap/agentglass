import type { NotifyTarget } from "../../../shared/notifyPayload.ts";
import type { SystemNote } from "./sysNotify.ts";

/** A target this app has a view for, as the router's destination. `url` has none: it is the one that leaves the app. */
export function gotoOfTarget(t: NotifyTarget): NonNullable<SystemNote["goto"]> | null {
  switch (t.kind) {
    case "pr": return { kind: "pr", repo: t.repo, number: t.number };
    case "pane": return { kind: "pane", pane: t.pane };
    case "file": return { kind: "file", root: t.root, path: t.path };
    case "card": return { kind: "card", id: t.id, label: t.label };
    case "url": return null;
  }
}
