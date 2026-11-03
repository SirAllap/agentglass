/*
 * Step 3's three groups, two counters and one row state, from `/dependencies`.
 *
 * The catalog's level decides the group, except for an agent CLI: the picked
 * agent is needed and every other agent row is optional, which is what keeps a
 * machine with four agents from showing four things "needing" attention.
 * Nothing here is a literal count.
 */
import {
  levelFor,
  needsYou,
  type DepLevel,
  type DepReport,
  type DepsResponse,
} from "../../../shared/deps.ts";

export interface ToolsGroup {
  level: DepLevel;
  title: string;
  why: string;
  rows: DepReport[];
}

const TITLE: Record<DepLevel, string> = { needed: "Needed", recommended: "Recommended", optional: "Optional" };
const WHY: Record<DepLevel, string> = {
  needed: "without these the app cannot do its job",
  recommended: "the app works without it, worse",
  optional: "never counted in what needs you",
};

/** The two counted groups, in reading order. Optional is shown, never counted. */
export const COUNTED: readonly DepLevel[] = ["needed", "recommended"];

function neededRank(id: string): number {
  if (id === "git") return 0;
  if (id === "python") return 1;
  return 2;
}

export function toolGroups(report: DepsResponse, picked: string): ToolsGroup[] {
  const live = report.deps.filter((d) => d.status !== "unsupported");
  const of = (level: DepLevel) => live.filter((d) => levelFor(d, picked) === level);
  const needed = of("needed").sort((a, b) => neededRank(a.id) - neededRank(b.id));
  return [
    { level: "needed", title: TITLE.needed, why: WHY.needed, rows: needed },
    { level: "recommended", title: TITLE.recommended, why: WHY.recommended, rows: of("recommended") },
    { level: "optional", title: TITLE.optional, why: WHY.optional, rows: of("optional") },
  ];
}

/** `N ready` among the two counted groups; the optional list never adds to it. */
export function readyCount(report: DepsResponse, picked: string): number {
  return report.deps.filter((d) => levelFor(d, picked) !== "optional" && d.status === "ok").length;
}

/** `M needs you` over the whole report, the picked agent included. */
export function needsCount(report: DepsResponse, picked: string): number {
  return report.deps.filter((d) => needsYou(d, picked)).length;
}

/** The rows the Fix all sheet lists: needed, and not ok, in reading order. */
export function fixableRows(report: DepsResponse, picked: string): DepReport[] {
  return toolGroups(report, picked)[0]!.rows.filter((d) => needsYou(d, picked));
}

export interface RowAction {
  label: string;
  /** The line to copy. Absent where no one line is true on every machine. */
  command?: string;
}

export interface ToolRowView {
  d: DepReport;
  /** The version or path, beside the name, when the report has one. */
  version: string | null;
  state: string;
  tone: "ok" | "warn" | "off";
  help: string;
  action?: RowAction;
}

/** A version is what `Ready · <version>` shows; a path or a sentence is not. */
function versionOf(d: DepReport): string | null {
  if (d.status !== "ok" || !d.detail) return null;
  // A version, or the path Python 3 is at: both are what "Ready ·" shows.
  return /^(v?\d|tmux \d)/.test(d.detail) || d.detail.startsWith("/") ? d.detail : null;
}

export function tmuxSourceLine(source: DepReport["tmuxSource"]): string | null {
  if (source === "bundled") return "agentglass brought its own tmux.";
  if (source === "system") return "Using the tmux already on this machine.";
  if (source === "env" || source === "custom") return "Using the tmux you chose.";
  return null;
}

export function toolRow(d: DepReport): ToolRowView {
  const version = versionOf(d);
  if (d.status === "ok") {
    return { d, version, state: "Ready", tone: "ok", help: tmuxSourceLine(d.tmuxSource) ?? d.what };
  }
  if (d.status === "missing") {
    return {
      d, version: null, state: "Not installed", tone: "warn", help: d.what,
      action: d.install ? { label: "Install", command: d.install } : undefined,
    };
  }
  // attention: installed, and the next step is not another install.
  if (d.id === "docker") {
    return {
      d, version, state: "Daemon off", tone: "off",
      help: "The Docker CLI is installed and its daemon is not answering. Start it the way your distribution does; agentglass never starts it behind your back.",
    };
  }
  if (d.id === "task") {
    return {
      d, version, state: "Installed, not set up", tone: "off",
      help: "One run creates its data store and asks its setup question.",
      action: d.signIn ? { label: "Set up", command: d.signIn } : undefined,
    };
  }
  if (d.signIn) {
    return {
      d, version, state: "Installed, not signed in", tone: "warn", help: d.what,
      action: { label: "Sign in", command: d.signIn },
    };
  }
  return { d, version, state: "Installed, not usable", tone: "warn", help: d.detail ?? d.what };
}
