import type { ControlCmd, ViewId } from "../../shared/types.ts";

// The allowlists the validator checks against. Held here, at the trust
// boundary, rather than derived from the UI: a /control body is untrusted input,
// and every field it can set must map to a closed set before it is broadcast to
// every browser tab. Kept in step with shared/types.ts by hand, and
// control.test.ts pins these values — the 0.8 redesign made the dashboard a
// view and added tasks, files and the browser, so an external controller can
// reach every one of them, not the six the workspace used to hold. `browser`
// earns its place for a further reason: an agent driving the built-in browser
// (browserdrive.ts) needs that view mounted before anything can answer it, and
// the alternative was telling the agent to ask a human to click a tab.
//
// `understudy` is on the list for the ORDINARY reason rather than a special
// one, and it is worth saying so out loud because the view sounds like it
// should be an exception: it is a scorecard of decisions a stand-in would have
// made, it acts on nothing, and everything it shows already rides the same
// read-only socket. A view the keyboard reaches with one key and /control
// answers 400 for is the drift this duplicated list exists to make visible.
const VIEW_IDS: readonly ViewId[] = ["dash", "git", "diff", "pr", "tasks", "docker", "term", "chat", "browser", "files", "lantern", "seat", "plugins"];
type OpenWhat = Exclude<Extract<ControlCmd, { cmd: "open" }>["what"], "finder">;
const OPEN_WHAT: readonly OpenWhat[] = ["stats", "skills", "search", "help", "palette"];
/** The longest path the finder will be asked about; PATH_MAX on Linux. */
const MAX_PATH = 4096;
type ChatDo = Extract<ControlCmd, { cmd: "chat" }>["do"];
const CHAT_DO: readonly ChatDo[] = ["new"];

/**
 * The path a finder command may carry, or null. Spelling only: nothing here
 * touches the disk, and whether the finder may LOOK at the place is answered
 * where it always was, by /browse and /preview each time a window asks, under
 * that window's own credentials. A refused or missing path therefore opens the
 * finder on its own "closed" or "not there" state rather than being second-
 * guessed here with the caller's locality instead of the viewer's.
 *
 * Absolute, and already normalized: no `.`, `..` or empty segment, so the string
 * every window shows and fetches is the one the caller wrote. A trailing slash
 * is the one spelling allowed to differ, and it is how a folder is asked for.
 * POSIX paths only; a Windows drive path is the next thing after this and is
 * not here.
 */
function finderPath(raw: unknown): { path: string; kind: "file" | "dir" } | null {
  if (typeof raw !== "string" || raw.length > MAX_PATH || !raw.startsWith("/")) return null;
  // Control characters, not just NUL: a newline in a path is a log-injection
  // and a rendering surprise in every window that draws it, never a real file.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw === "/") return { path: "/", kind: "dir" };
  const dir = raw.endsWith("/");
  const body = dir ? raw.slice(0, -1) : raw;
  if (body.slice(1).split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return { path: body, kind: dir ? "dir" : "file" };
}

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
      if (b.what === "finder") {
        const f = finderPath(b.path);
        return f ? { cmd: "open", what: "finder", ...f } : null;
      }
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
