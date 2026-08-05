import type { ControlCmd, ViewId } from "../../shared/types.ts";

// The allowlists the validator checks against. Held here, at the trust
// boundary, rather than derived from the UI: a /control body is untrusted input,
// and every field it can set must map to a closed set before it is broadcast to
// every browser tab. Kept in step with shared/types.ts by hand, and
// control.test.ts pins these values — the 0.8 redesign made the dashboard a
// view and added tasks, files and the browser, so an external controller can
// reach every one of them, not the six the workspace used to hold.
const VIEW_IDS: readonly ViewId[] = ["dash", "git", "diff", "pr", "tasks", "docker", "term", "chat", "browser", "files"];
type OpenWhat = Extract<ControlCmd, { cmd: "open" }>["what"];
const OPEN_WHAT: readonly OpenWhat[] = ["stats", "skills", "search", "help", "palette"];
type ChatDo = Extract<ControlCmd, { cmd: "chat" }>["do"];
const CHAT_DO: readonly ChatDo[] = ["new"];

/**
 * Validate an untrusted POST /control body into a ControlCmd, or null.
 *
 * The command rides the same socket every dashboard tab holds, so a malformed
 * or unknown cmd is turned away here rather than broadcast for each client to
 * second-guess. Nothing here executes — the worst a valid command does is open
 * a panel or repaint a theme — but a string that reached a setter unchecked
 * would still be a bug, so each field is matched against a closed set.
 */
export function parseControlCmd(body: unknown): ControlCmd | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  switch (b.cmd) {
    case "view":
      return VIEW_IDS.includes(b.to as ViewId) ? { cmd: "view", to: b.to as ViewId } : null;
    case "workspace":
      // `open` optional: absent = toggle, boolean = set. Anything else is dropped.
      if (b.open === undefined) return { cmd: "workspace" };
      return typeof b.open === "boolean" ? { cmd: "workspace", open: b.open } : null;
    case "esc":
      return { cmd: "esc" };
    case "open":
      return OPEN_WHAT.includes(b.what as OpenWhat) ? { cmd: "open", what: b.what as OpenWhat } : null;
    case "theme":
      // A name pins one palette; a direction steps the list. Name wins if both
      // are sent. Neither, or a bad direction, is not a command.
      if (typeof b.name === "string" && b.name) return { cmd: "theme", name: b.name };
      if (b.dir === 1 || b.dir === -1) return { cmd: "theme", dir: b.dir };
      return null;
    case "zoom":
      return b.dir === 1 || b.dir === -1 || b.dir === 0 ? { cmd: "zoom", dir: b.dir } : null;
    case "chat":
      // A closed set of one rather than a free string, because the verbs that
      // want to join it — compacting, sending — reach into a real conversation.
      return CHAT_DO.includes(b.do as ChatDo) ? { cmd: "chat", do: b.do as ChatDo } : null;
    default:
      return null;
  }
}
