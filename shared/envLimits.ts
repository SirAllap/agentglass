/**
 * The limits the environment used to hold alone. Each is a setting now: the value stored here is what the app
 * uses until the variable is set, and a variable that is set wins and locks the row (the page names it).
 * Every one is the person's: an agent can neither loosen nor tighten them through the settings door, because a
 * limit an agent could move is not a limit.
 *
 * `switch` stores "1" or "0" and is read as the variable would be. `restart` marks a limit the app reads once
 * when it starts, so a change waits for the next start and the row says so.
 */
export type EnvLimit = {
  env: string;
  id: string;
  kind: "switch" | "number" | "text";
  label: string;
  hint: string;
  restart?: true;
  min?: number;
  max?: number;
};

const START = "Read once when the app starts.";

export const ENV_LIMITS: readonly EnvLimit[] = [
  { env: "AGENTGLASS_ALLOWED_HOSTS", id: "limits.allowedHosts", kind: "text", restart: true, label: "Extra host names this app answers to", hint: `A reverse-proxy name, comma separated. Others are refused as DNS rebinding. ${START}` },
  { env: "AGENTGLASS_ALLOW_REMOTE", id: "limits.allowRemote", kind: "switch", label: "Let integrations point at hosts outside your network", hint: "Off: a base URL naming a public host is refused." },
  { env: "AGENTGLASS_TRUST_LAN", id: "limits.trustLan", kind: "switch", restart: true, label: "Trust browsers on your local network", hint: `Off: a LAN browser is refused as cross-origin. ${START}` },
  { env: "AGENTGLASS_BROWSER_READONLY", id: "limits.browserReadonly", kind: "switch", label: "Agents' browser may read but not act", hint: "On: every acting verb is refused; reading, screenshots and logs still work." },
  { env: "AGENTGLASS_BROWSER_ROBOTS", id: "limits.browserRobots", kind: "switch", label: "Agents' browser honours robots.txt", hint: "On: a path a site's robots.txt disallows is refused." },
  { env: "AGENTGLASS_BROWSER_WEBMCP", id: "limits.browserWebmcp", kind: "switch", label: "Agents may read and run the tools a page offers", hint: "Off: only the DOM verbs work." },
  { env: "AGENTGLASS_CHAT_BYPASS", id: "limits.chatBypass", kind: "switch", label: "Chat may run in bypass mode", hint: "Off: a chat cannot start with every permission dialog skipped." },
  { env: "AGENTGLASS_CODEX_DISABLED", id: "limits.codexDisabled", kind: "switch", label: "Turn the OpenAI command-line engine off", hint: "On: the app does not use it." },
  { env: "AGENTGLASS_COMMIT_DISABLED", id: "limits.commitDisabled", kind: "switch", restart: true, label: "Turn committing from the app off", hint: `On: the app makes no commit. ${START}` },
  { env: "AGENTGLASS_CONTROL_LEVEL", id: "limits.controlLevel", kind: "number", min: 1, max: 3, label: "How far the control door reaches", hint: "1 opens and reads, 2 also acts, 3 does everything it offers." },
  { env: "AGENTGLASS_CONTROL_READONLY", id: "limits.controlReadonly", kind: "switch", label: "Hold the control door read-only", hint: "On: it stays at level 1 whatever the level says." },
  { env: "AGENTGLASS_DISK_DISABLED", id: "limits.diskDisabled", kind: "switch", label: "Turn searching the machine off", hint: "On: no search of the disk, and no file attached from outside the workspace." },
  { env: "AGENTGLASS_DISK_ROOTS", id: "limits.diskRoots", kind: "text", label: "Extra folders machine search may read", hint: "Paths separated by a colon, like PATH, added to the home folder." },
  { env: "AGENTGLASS_DOCKER_WRITE_DISABLED", id: "limits.dockerWriteDisabled", kind: "switch", restart: true, label: "Turn Docker changes off", hint: `On: the app removes nothing in Docker. ${START}` },
  { env: "AGENTGLASS_EDITOR_DISABLED", id: "limits.editorDisabled", kind: "switch", restart: true, label: "Turn opening files in your editor off", hint: `On: no editor is launched. ${START}` },
  { env: "AGENTGLASS_FS_BROWSE_DISABLED", id: "limits.fsBrowseDisabled", kind: "switch", label: "Turn browsing folders off", hint: "On: the folder picker and file reads are refused." },
  { env: "AGENTGLASS_GATE_FAILCLOSED", id: "limits.gateFailClosed", kind: "switch", restart: true, label: "Deny a waiting request when nobody answers", hint: `On: an unanswered gate is denied; off: it is allowed. ${START}` },
  { env: "AGENTGLASS_GATE_TIMEOUT", id: "limits.gateTimeout", kind: "number", min: 1, max: 86400, restart: true, label: "Seconds a gate waits for an answer", hint: `Then the fail-closed switch decides. ${START}` },
  { env: "AGENTGLASS_GIT_TIMEOUT_SECONDS", id: "limits.gitTimeout", kind: "number", min: 1, max: 3600, label: "Seconds one git command may run", hint: "Then the app stops it." },
  { env: "AGENTGLASS_GIT_WRITE_DISABLED", id: "limits.gitWriteDisabled", kind: "switch", restart: true, label: "Turn git changes from the app off", hint: `On: no branch, push or pull request is written. ${START}` },
  { env: "AGENTGLASS_MAX_TERMINALS", id: "limits.maxTerminals", kind: "number", min: 4, max: 2000, restart: true, label: "Most terminals open at once", hint: START },
  { env: "AGENTGLASS_PLUGINS_UNBOXED", id: "limits.pluginsUnboxed", kind: "switch", label: "Run every plugin outside its sandbox", hint: "On: a plugin that asks for no sandbox runs anyway. Only you turn it on." },
  { env: "AGENTGLASS_RATE_MAX", id: "limits.rateMax", kind: "number", min: 10, max: 100000, restart: true, label: "Most requests one client may make per window", hint: START },
  { env: "AGENTGLASS_RATE_WINDOW_MS", id: "limits.rateWindow", kind: "number", min: 1000, max: 3600000, restart: true, label: "Length of that window, in milliseconds", hint: START },
  { env: "AGENTGLASS_SCAN_DISABLED", id: "limits.scanDisabled", kind: "switch", restart: true, label: "Turn reading transcripts off", hint: `On: spend and sessions are not read from transcripts. ${START}` },
  { env: "AGENTGLASS_SLICE_MEMORY_MAX", id: "limits.sliceMemoryMax", kind: "text", restart: true, label: "Memory the app itself may hold", hint: `A size like 20G. Empty is automatic. ${START}` },
  { env: "AGENTGLASS_SPAWN_LIMIT", id: "limits.spawnLimit", kind: "number", min: 1, max: 16, label: "Child processes the app starts at once", hint: START },
  { env: "AGENTGLASS_TASK_WRITE_DISABLED", id: "limits.taskWriteDisabled", kind: "switch", restart: true, label: "Turn writing to the task board off", hint: `On: the board is read-only. ${START}` },
  { env: "AGENTGLASS_TERMINAL_DISABLED", id: "limits.terminalDisabled", kind: "switch", label: "Turn the terminal off", hint: "On: no terminal can be opened." },
  { env: "AGENTGLASS_TMUX_OBSERVE_ONLY", id: "limits.tmuxObserveOnly", kind: "switch", label: "Watch tmux but never type into it", hint: "On: the app only reads panes." },
  { env: "AGENTGLASS_WALKTHROUGH_DISABLED", id: "limits.walkthroughDisabled", kind: "switch", label: "Turn walkthroughs off", hint: "On: no walkthrough is generated." },
];

/** Set by whoever starts a separate MCP or CLI process; that process cannot read this app's store, so the server cannot lock it. */
export const LAUNCH_FLAGS = "a launch flag of a separate MCP or CLI process, set by whoever starts it";
