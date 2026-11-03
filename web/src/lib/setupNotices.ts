/*
 * What the first run says about the window it is in.
 *
 * The shell is the only place that knows the port it would have preferred and
 * the one it settled on, and it hands over both numbers with no sentence: the
 * words are built here, so the same strip reads the same wherever the window
 * runs. A browser tab the server itself served has no shell to ask, and falls
 * back to the app's own port against the page's.
 */
/** The port the app asks for first; the shell's own default and api.ts's guess. */
export const APP_PORT = 4000;

/** A note about one port, not a fact about the person: it names the port it
 *  dismissed, so a window on another port asks again. */
export const PORT_DISMISSED_KEY = "agentglass.portNoticeDismissed";

export interface ShellNoticeFacts {
  preferredPort: number | null;
  serverPort: number | null;
  displayServer: "wayland" | "x11" | null;
}

export interface NoticePorts {
  preferredPort: number;
  port: number;
}

export interface PortNotice extends NoticePorts {
  /** What `Dismiss` stores: this window's port. */
  dismissValue: string;
}

/** Where each number comes from, or null when one is missing. */
export function noticePorts(
  shell: ShellNoticeFacts & { desktop: boolean },
  apiPort: number | null,
): NoticePorts | null {
  const port = shell.serverPort ?? apiPort;
  if (port == null || !Number.isFinite(port)) return null;
  // An older shell without the number is not a reason to guess: only a plain
  // browser tab, whose page is the server, knows the app's default applies.
  const preferredPort = shell.preferredPort ?? (shell.desktop ? null : APP_PORT);
  if (preferredPort == null) return null;
  return { preferredPort, port };
}

/** The strip exists only while the window is not on the port it asked for, and
 *  only while this person has not dismissed this port. */
export function portNotice(ports: NoticePorts | null, dismissed: string | null): PortNotice | null {
  if (!ports) return null;
  if (ports.preferredPort === ports.port) return null;
  if (dismissed === String(ports.port)) return null;
  return { ...ports, dismissValue: String(ports.port) };
}

/** Both numbers, what follows the server's port, and what does not. Never a
 *  claim about who holds the other one. */
export function portNoticeText(notice: PortNotice): { title: string; body: string } {
  return {
    title: `This window is on port ${notice.port}, not ${notice.preferredPort}.`,
    body: `Hooks and CLIs read the port the server wrote, so they follow it. A shell still pointing at ${notice.preferredPort} does not.`,
  };
}

/** Nothing on Wayland, where the window is drawn natively. */
export function displayLine(server: "wayland" | "x11" | null): string | null {
  return server === "x11" ? "This window is drawn through X11." : null;
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function readDismissedPort(store: Store = localStorage): string | null {
  try { return store.getItem(PORT_DISMISSED_KEY); } catch { return null; }
}

export function dismissPortNotice(port: number, store: Store = localStorage): void {
  try { store.setItem(PORT_DISMISSED_KEY, String(port)); } catch { /* no storage */ }
}

/** The API's own port, when the page was served by it. */
export function apiPortOf(origin: string): number | null {
  try {
    const p = Number(new URL(origin).port);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}
