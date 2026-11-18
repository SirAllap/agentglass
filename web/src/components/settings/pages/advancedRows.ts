// The rows of the Advanced page, as data: every writable machine row of the old pages,
// each with one line saying when you would touch it. Pure, so tests need no DOM.
// Machine limits come from the shared ENV_LIMITS table (one row each, restart tag from it);
// the rest are listed here. A row with a setting id is read and written through the settings door.
import { ENV_LIMITS } from "../../../../../shared/envLimits.ts";

export type AdvControl =
  | { kind: "bool" }
  | { kind: "choice"; options: { value: string; label: string }[] }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "text"; placeholder?: string }
  | { kind: "list"; placeholder?: string }
  | { kind: "mcp" }
  /** A tmux engine field, saved through the tmux door (TmuxRows.tsx). */
  | { kind: "tmux"; field: "mode" | "override" | "path" | "binary" | "customPrefix" | "prefix" | "runsOn" }
  /** Writable, but its editor is not on the settings door yet: a link row to where it is edited today. */
  | { kind: "link"; pane: string; linkText: string };

export type AdvRow = AdvControl & {
  /** The setting id the door reads and writes. Link rows have none. */
  id?: string;
  /** Unique key for lists and tests; the setting id when there is one. */
  key: string;
  label: string;
  section: string;
  /** "When you would touch this": one sentence, 14 words at most. Shown as the row's help. */
  touch: string;
  /** Read once at start: the row carries the restart tag. */
  restart?: boolean;
  /** A setting an agent must not reach; the text says why. */
  agentNever?: string;
  /** An environment variable may hold it: the door says which and the row locks. */
  lockable?: boolean;
};

export const ADVANCED_SECTIONS = ["Terminal engine", "Worker sandbox", "Watching tuning", "Flow tuning", "Machine limits and switches", "Network"] as const;

const mins = (...n: number[]) => n.map((m) => ({ value: String(m), label: m === 60 ? "1 hour" : `${m} min` }));

const KILL = "Kill switch. Use it on a shared or locked-down machine.";

/** What each machine limit is for, by id. */
const LIMIT_TOUCH: Record<string, string> = {
  "limits.browserWebmcp": "Let agents use page tools in the browser.",
  "limits.browserRobots": "Agents' browser should obey robots.txt.",
  "limits.browserReadonly": "Agents may look at pages but never click.",
  "limits.chatBypass": "Allow chat to skip permission prompts.",
  "limits.spawnLimit": "The machine chokes on too many child processes.",
  "limits.gateFailClosed": "Unattended machine: fail closed.",
  "limits.diskRoots": "Search should reach folders outside the usual roots.",
  "limits.allowedHosts": "You reach the app by another host name.",
  "limits.controlReadonly": "Agents may look but never act.",
  "limits.controlLevel": "Limit what the control door exposes.",
  "limits.rateWindow": "Tune the request-rate window.",
  "limits.allowRemote": "Touch only when the default fails on this machine.",
  "limits.sliceMemoryMax": "The app itself runs out of memory.",
  "limits.rateMax": "A client is throttled too hard or not enough.",
  "limits.maxTerminals": "Cap terminals on a small machine.",
  "limits.pluginsUnboxed": "Debug a plugin. Never as a habit.",
  "limits.gateTimeout": "A gate times out before you answer.",
  "limits.gitTimeout": "A git command on a huge repo times out.",
  "limits.trustLan": "You open the app from another device on your LAN.",
  "limits.fsBrowseDisabled": KILL,
  "limits.commitDisabled": KILL,
  "limits.dockerWriteDisabled": KILL,
  "limits.gitWriteDisabled": KILL,
  "limits.editorDisabled": KILL,
  "limits.diskDisabled": KILL,
  "limits.codexDisabled": KILL,
  "limits.terminalDisabled": KILL,
  "limits.walkthroughDisabled": KILL,
  "limits.taskWriteDisabled": KILL,
  "limits.scanDisabled": KILL,
  "limits.tmuxObserveOnly": "Watch-only mode for tmux.",
};

const limitRows: AdvRow[] = ENV_LIMITS.map((l): AdvRow => {
  const base = { id: l.id, key: l.id, label: l.label, section: "Machine limits and switches", touch: LIMIT_TOUCH[l.id] ?? "", restart: l.restart, lockable: true as const };
  if (l.kind === "switch") return { ...base, kind: "bool" };
  if (l.kind === "number") return { ...base, kind: "number", min: l.min, max: l.max };
  return { ...base, kind: "text" };
});

const own: AdvRow[] = [
  { key: "tmux.mode", kind: "tmux", field: "mode", label: "Mode", section: "Terminal engine", touch: "Only when you fix tmux by hand." },
  { key: "tmux.override", kind: "tmux", field: "override", label: "Override config", section: "Terminal engine", touch: "Use your own tmux config. Only if you keep one." },
  { key: "tmux.path", kind: "tmux", field: "path", label: "Path to the binary", section: "Terminal engine", touch: "tmux is not on your PATH." },
  { key: "tmux.binary", kind: "tmux", field: "binary", label: "tmux binary", section: "Terminal engine", touch: "Pick a different tmux build." },
  { key: "tmux.customPrefix", kind: "tmux", field: "customPrefix", label: "Custom prefix key", section: "Terminal engine", touch: "Your own tmux prefix." },
  { key: "tmux.prefix", kind: "tmux", field: "prefix", label: "Prefix key", section: "Terminal engine", touch: "The tmux prefix collides with another tool." },
  { id: "terminal.relay", key: "terminal.relay", kind: "bool", label: "Own process for terminals", section: "Terminal engine", touch: "On by default. Typing still echoes while the app is busy.", restart: true },
  { key: "tmux.runsOn", kind: "tmux", field: "runsOn", agentNever: "which tmux a shell runs in, held by the server: it changes what runs a shell, so the owner chooses it", label: "Terminal runs on", section: "Terminal engine", touch: "Pick the terminal host. Only to debug." },

  { id: "workers.unwalledEngines", key: "workers.unwalledEngines", kind: "bool", label: "Engines with no read wall", section: "Worker sandbox", touch: "An engine cannot be walled off. Only if you accept that risk." },
  { key: "workers.alsoRefuse", kind: "link", pane: "orchestration", linkText: "Open", label: "Most allowed: also refuse", section: "Worker sandbox", touch: "Add refusals on top of most-allowed. Only if a worker overstepped." },
  { id: "workers.plannerWrite", key: "workers.plannerWrite", kind: "bool", label: "Planner may write its own worktree and .agx-tmp", section: "Worker sandbox", touch: "Only if planner runs fail on write." },
  { id: "workers.gitInternals", key: "workers.gitInternals", kind: "bool", label: "Worker git internals", section: "Worker sandbox", touch: "Let a worker touch .git. Only if it must rewrite history." },
  { id: "workers.projectSkills", key: "workers.projectSkills", kind: "bool", label: "Load the project's own skills and commands", section: "Worker sandbox", touch: "Only if a worker misses a repo command." },
  { id: "workers.noClaude", key: "workers.noClaude", kind: "bool", label: "No Claude in workers", section: "Worker sandbox", touch: "Roles set to Claude start on OpenCode. Only to save Claude usage." },
  { id: "workers.mcpServers", key: "workers.mcpServers", kind: "mcp", label: "MCP servers a worker role may use", section: "Worker sandbox", touch: "Limit which tool servers a role may reach. Only when you add one." },
  { id: "agents.permissionMode", key: "agents.permissionMode", kind: "choice", options: [{ value: "", label: "Role default" }, { value: "dontAsk", label: "Don't ask" }, { value: "bypassPermissions", label: "Bypass" }], label: "Permission mode a worker role starts in", section: "Worker sandbox", touch: "Start mode per role. Only to make one role stricter." },
  { id: "workers.claudeConfigDir", key: "workers.claudeConfigDir", kind: "text", label: "Claude Code account for this project", section: "Worker sandbox", touch: "Folder of the Claude login its agents use. Only to keep two accounts apart." },
  { id: "workers.unixSockets", key: "workers.unixSockets", kind: "choice", options: [{ value: "off", label: "Off" }, { value: "all", label: "All" }], label: "Worker unix sockets", section: "Worker sandbox", touch: "Sockets a sandboxed worker may open. Only when a tool needs one." },

  { id: "lantern.nudgeMinutes", key: "lantern.nudgeMinutes", kind: "choice", options: mins(10, 20, 45, 90), label: "How often one session may be asked again", section: "Watching tuning", touch: "Check-ins feel too frequent." },
  { id: "lantern.cacheTtlMinutes", key: "lantern.cacheTtlMinutes", kind: "choice", options: mins(5, 60), label: "How long the prompt cache stays warm", section: "Watching tuning", touch: "Tune cost against speed for long agent sessions." },
  { id: "lantern.watchMinutes", key: "lantern.watchMinutes", kind: "choice", options: mins(5, 10, 15, 30, 60), label: "How often it looks", section: "Watching tuning", touch: "Watching is too slow or burns CPU." },

  { id: "flow.notifyPrReviews.bots", key: "flow.notifyPrReviews.bots", kind: "list", placeholder: "one login per line", label: "Extra logins that count as a bot's review", section: "Flow tuning", touch: "A new review bot appears in your PRs." },
  { id: "flow.nextCard.cap", key: "flow.nextCard.cap", kind: "number", min: 1, label: "Most scouts running at once for this filter", section: "Flow tuning", touch: "A saved filter feeds too many scouts at once." },
  { id: "flow.nextCard.filterId", key: "flow.nextCard.filterId", kind: "text", label: "The saved filter to read, by its id", section: "Flow tuning", touch: "You need a filter the picker cannot name." },
  { id: "seat.wakeHours", key: "seat.wakeHours", kind: "choice", options: [1, 2, 4, 8, 12, 24].map((h) => ({ value: String(h), label: h === 1 ? "1 hour" : `${h} hours` })), label: "Wake the orchestrator at least every", section: "Flow tuning", touch: "The orchestrator sleeps too long or too little." },

  { key: "remote.address", kind: "link", pane: "remote", linkText: "Open", label: "Address", section: "Network", touch: "Bind to another address. Only for LAN or tunnel setups." },
  { key: "remote.origins", kind: "link", pane: "remote", linkText: "Open", label: "Private-network origins", section: "Network", touch: "Let a private-network origin reach this app." },
  { key: "remote.route", kind: "link", pane: "remote", linkText: "Open", label: "Route", section: "Network", touch: "Pick the network route a phone uses." },
];

const ORDER = new Map<string, number>(ADVANCED_SECTIONS.map((s, i) => [s, i]));

/** Every Advanced row, grouped by section in the page order. Limits keep the shared table's order. */
export const ADVANCED_ROWS: readonly AdvRow[] = [...own, ...limitRows]
  .map((r, i) => ({ r, i }))
  .sort((a, b) => (ORDER.get(a.r.section) ?? 99) - (ORDER.get(b.r.section) ?? 99) || a.i - b.i)
  .map((x) => x.r);

/** Filter by label and help text, nothing else. An empty query keeps every row. */
export function filterAdvanced(rows: readonly AdvRow[], q: string): AdvRow[] {
  const n = q.trim().toLowerCase();
  if (!n) return [...rows];
  return rows.filter((r) => r.label.toLowerCase().includes(n) || r.touch.toLowerCase().includes(n));
}

/** Words in a help line. */
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
