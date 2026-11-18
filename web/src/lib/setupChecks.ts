/*
 * Setup step 6, Checks: one last look at what the app leans on.
 *
 * Pure: the step reads the four answers (dependencies, agents, the browser
 * tools, the notification permission) and this turns them into rows. Each row
 * has at most one Fix, and every Fix is a call that already exists elsewhere:
 * copy the install line, reset tmux, install the browser tools, or ask for the
 * notification permission. Finish is never blocked by a red row.
 */
import type { DepReport } from "../../../shared/deps.ts";
import type { NoticePorts } from "./setupNotices.ts";
import type { AgentProbe, BrowserUseStatus } from "../../../shared/types.ts";

export type CheckTone = "ok" | "warn" | "bad";

export type CheckFix =
  /** Copy a line to paste into a terminal, then Recheck. */
  | { kind: "copy"; label: string; line: string }
  /** `api.browserUseInstall()` then `api.browserUseStatus()`. */
  | { kind: "browserInstall"; label: string }
  /** `askNotifyPermission()` then a test note. */
  | { kind: "notify"; label: string }
  /** Denied cannot be asked again from script: say how to allow it in the OS. */
  | { kind: "osHelp"; label: string; help: string }
  /** `api.hooksInstall()` then `api.hooksStatus()`. */
  | { kind: "hooksInstall"; label: string }
  /** Nothing to fix: read it again. */
  | { kind: "recheck"; label: string };

export interface CheckRow {
  id: "tmux" | "agents" | "browser" | "gh" | "port" | "hooks" | "notify";
  title: string;
  tone: CheckTone;
  detail: string;
  fix: CheckFix | null;
  /** Still being read: drawn, but not counted as needing you. */
  pending?: true;
}

export interface CheckInput {
  /** The `tmux` row of `api.dependencies()`; undefined while it is read. */
  tmux: DepReport | undefined;
  /** `api.agents()`; null while it is read. */
  agents: readonly AgentProbe[] | null;
  /** The install line for the agent picked at step 1, from the catalogue. */
  agentInstall: string | null;
  /** `api.browserUseStatus()`; null while it is read or when it failed. */
  browser: BrowserUseStatus | null;
  /** `notifyPermission()`: null is a host with no Notification API at all. */
  notify: NotificationPermission | null;
  /** `api.prCapability()`; null or absent while it is read or when it failed: no row. */
  gh?: { available: boolean; authed: boolean; login?: string } | null;
  /** `noticePorts(...)`; null when a number is missing: no row. */
  ports?: NoticePorts | null;
  /** `api.hooksStatus().installed`; null or absent while it is read: no row. */
  hooks?: boolean | null;
}

const DENIED_HELP =
  "Notifications are blocked for agentglass. Allow them in your system's notification settings, then press Recheck.";

const TMUX_HELP =
  "agentglass starts tmux by itself when a terminal opens. If it still does not answer, see Settings ▸ Terminal, then press Recheck.";

const GH_HELP = "Install the GitHub CLI from cli.github.com, run gh auth login, then press Recheck.";

const PORT_HELP =
  "Another program holds the port agentglass asked for, so it moved. Close that program and restart agentglass to get the port back. Nothing breaks meanwhile.";

export function checkRows(i: CheckInput): CheckRow[] {
  const rows: CheckRow[] = [];

  const t = i.tmux;
  if (!t) rows.push({ id: "tmux", title: "Terminal engine (tmux)", tone: "warn", detail: "Checking…", fix: null, pending: true });
  else if (t.status === "ok") rows.push({ id: "tmux", title: "Terminal engine (tmux)", tone: "ok", detail: t.detail ? `tmux ${t.detail}` : "tmux works", fix: null });
  else if (t.status === "missing") rows.push({
    id: "tmux", title: "Terminal engine (tmux)", tone: "bad", detail: "tmux is not on this machine. Terminals need it.",
    fix: t.install ? { kind: "copy", label: "Fix", line: t.install } : null,
  });
  // `unsupported` is a platform with no tmux in use: nothing to check, no row.
  // Any other state only explains. A one-click Fix here must never reset or
  // kill the tmux server: every tab and agent of the person lives on it.
  else if (t.status !== "unsupported") rows.push({
    id: "tmux", title: "Terminal engine (tmux)", tone: "warn", detail: t.detail || "tmux is here but does not answer.",
    fix: { kind: "osHelp", label: "Fix", help: TMUX_HELP },
  });

  if (i.agents == null) rows.push({ id: "agents", title: "Agent CLIs", tone: "warn", detail: "Checking…", fix: null, pending: true });
  else {
    const found = i.agents.filter((a) => a.found);
    rows.push(found.length
      ? { id: "agents", title: "Agent CLIs", tone: "ok", detail: found.map((a) => a.label).join(" · "), fix: { kind: "recheck", label: "Recheck" } }
      : {
        id: "agents", title: "Agent CLIs", tone: "bad", detail: "No agent CLI found on this machine yet.",
        fix: i.agentInstall ? { kind: "copy", label: "Fix", line: i.agentInstall } : { kind: "recheck", label: "Recheck" },
      });
  }

  // A browser build without the desktop app has no browser tools to install.
  const b = i.browser;
  if (b && b.desktop) {
    const ready = b.cli.state === "installed" && (b.skill.state === "current" || b.skill.state === "unshipped");
    rows.push(ready
      ? { id: "browser", title: "Browser for agents", tone: "ok", detail: "The agent tools are installed", fix: null }
      : { id: "browser", title: "Browser for agents", tone: "warn", detail: "The agent tools are not installed yet", fix: { kind: "browserInstall", label: "Fix" } });
  }

  const g = i.gh;
  if (g) {
    if (!g.available) rows.push({
      id: "gh", title: "GitHub CLI (gh)", tone: "warn", detail: "gh is not on this machine. The PR board needs it.",
      fix: { kind: "osHelp", label: "Fix", help: GH_HELP },
    });
    else if (!g.authed) rows.push({
      id: "gh", title: "GitHub CLI (gh)", tone: "warn", detail: "gh is here but not signed in.",
      fix: { kind: "copy", label: "Fix", line: "gh auth login" },
    });
    else rows.push({ id: "gh", title: "GitHub CLI (gh)", tone: "ok", detail: g.login ? `Signed in as ${g.login}` : "Signed in", fix: null });
  }

  const p = i.ports;
  if (p) rows.push(p.port === p.preferredPort
    ? { id: "port", title: "Port", tone: "ok", detail: `This window is on port ${p.port}`, fix: null }
    : {
      id: "port", title: "Port", tone: "warn", detail: `This window is on port ${p.port}, not ${p.preferredPort}.`,
      fix: { kind: "osHelp", label: "Fix", help: PORT_HELP },
    });

  if (i.hooks != null) rows.push(i.hooks
    ? { id: "hooks", title: "Agent hooks", tone: "ok", detail: "Installed", fix: null }
    : { id: "hooks", title: "Agent hooks", tone: "warn", detail: "Not installed. Agents will not show up live.", fix: { kind: "hooksInstall", label: "Fix" } });

  if (i.notify === "granted") rows.push({ id: "notify", title: "Notifications", tone: "ok", detail: "Allowed", fix: null });
  else if (i.notify === "default") rows.push({
    id: "notify", title: "Notifications", tone: "bad", detail: "Not allowed yet. You will miss “needs you”.", fix: { kind: "notify", label: "Fix" },
  });
  else if (i.notify === "denied") rows.push({
    id: "notify", title: "Notifications", tone: "bad", detail: "Blocked. You will miss “needs you”.",
    fix: { kind: "osHelp", label: "Fix", help: DENIED_HELP },
  });

  return rows;
}

/** The footer's tally: rows that are not ok and are not still being read. */
export function checksNeedingYou(rows: readonly CheckRow[]): number {
  return rows.filter((r) => r.tone !== "ok" && !r.pending).length;
}
