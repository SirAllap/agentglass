/*
 * Every limit on a worker has a control the person can see.
 *
 * A restriction nobody can see or change in Settings is one nobody can reason
 * about, so this reads source as text and fails when one has none. It has no
 * exception list for settings: a def without `data-setting="<id>"` in some
 * web/src/**\/*.tsx file fails the build, and so does a worker restriction or an
 * AGENTGLASS_* limit that is not a def.
 *
 * Naming this test holds the rest of the plan to:
 *   workers.commands.<command>   one per SWITCHABLE_COMMANDS entry, a space becoming "-" (git push -> git-push)
 *   workers.appDoors.<door>      one per WORKER_DENIED door except agentglass-browser (browser.workers drives that one)
 * and an AGENTGLASS_* limit appears, by name, in server/src/serverSettings.ts
 * next to the def that drives it.
 *
 * What counts as a limit: an AGENTGLASS_* name is a LIMIT when setting it
 * refuses or narrows something an agent may do (a verb, path, host, size or
 * count). It is PLUMBING when it only locates or identifies something (an
 * app-owned file path, a port, a socket, a token, a role label), or only tunes
 * the server's own work. Each plumbing name below sits with the clause it
 * meets; a name with no clause here and no def fails.
 */
import { LAUNCH_FLAGS } from "../../shared/envLimits.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWITCHABLE_COMMANDS } from "../../shared/workerRoles.ts";
import { WORKER_DENIED } from "../src/agents/envelope.ts";
import { serverSettingDefs } from "../src/serverSettings.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const files = (dir: string, glob: string) => [...new Bun.Glob(glob).scanSync({ cwd: join(ROOT, dir), absolute: true })]
  .filter((f) => !f.includes("node_modules"));

const defs = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} });
const defIds = defs.map((d) => d.id);
const webSource = files("web/src", "**/*.tsx").map((f) => readFileSync(f, "utf8")).join("\n");
/* The defs are written in serverSettings.ts; the limits the environment also holds are listed in shared/envLimits.ts and become defs there (`ENV_LIMITS.map`). */
const settingsSource = read("server/src/serverSettings.ts") + read("shared/envLimits.ts");

/** The clauses a plumbing name can meet. */
const PATH = "locates an app-owned file or directory";
const PORT = "a port, address or URL the app is reached at";
const TOKEN = "a token or credential the app mints and hands over";
const WHO = "names or identifies who or what is running (a role, agent, seat, tab label)";
const TUNE = "tunes the server's own work (an interval, a batch size, a cache age) and gives an agent no reach";
const BUILD = "stamps a build, a version or an update source";
const UP = "points at a third-party service base URL";
const ACTION = "the context a user action is run with (a path, id, mode handed to a script)";
const SWITCH = "a developer switch for tests or debugging, not a worker limit";
const LAUNCH = LAUNCH_FLAGS;
const SETBYAPP = "set by the app itself on a window it opens, from a setting that already has its row";

const PLUMBING: Readonly<Record<string, string>> = {
  AGENTGLASS_ACTION_CONTEXT: ACTION, AGENTGLASS_ACTION_COUNT: ACTION, AGENTGLASS_ACTION_DIR: ACTION, AGENTGLASS_ACTION_ID: ACTION,
  AGENTGLASS_ACTION_MODE: ACTION, AGENTGLASS_ACTION_PARENT: ACTION, AGENTGLASS_ACTION_PATHS: ACTION, AGENTGLASS_ACTION_POSITION: ACTION,
  AGENTGLASS_ACTION_PROGRESS: ACTION, AGENTGLASS_ACTION_RUN_DIR: ACTION, AGENTGLASS_ACTION_SOURCE: ACTION, AGENTGLASS_ACTION_VERSION: ACTION,
  AGENTGLASS_AGENT_NAME: WHO, AGENTGLASS_AUTOFETCH_SECONDS: TUNE, AGENTGLASS_BENCH_NOTES: PATH, AGENTGLASS_BIND: PORT,
  AGENTGLASS_BROWSER_AS: WHO, AGENTGLASS_BROWSER_AUDIT_LOG: PATH, AGENTGLASS_BROWSER_OFF_REASON: WHO, AGENTGLASS_BROWSER_SHOW: TUNE,
  AGENTGLASS_BROWSER_STATE_DIR: PATH, AGENTGLASS_BROWSER_WAIT: TUNE, AGENTGLASS_BUILDER_WORKTREE: PATH, AGENTGLASS_BUN: PATH,
  AGENTGLASS_BWRAP: PATH, AGENTGLASS_CACHE_DIR: PATH, AGENTGLASS_CLAUDE_HOME: PATH, AGENTGLASS_CLAUDE_MODELS: TUNE,
  // How much memory the desktop app reserves for itself; the Requirements page reads the same amount (memreserve.ts).
  AGENTGLASS_MEMORY_LOW: TUNE,
  AGENTGLASS_CLICKUP_BASE: UP, AGENTGLASS_COCKPIT_HTTP: PORT, AGENTGLASS_COCKPIT_TOKEN: TOKEN, AGENTGLASS_CODE_DIR: PATH,
  AGENTGLASS_CODEX_USAGE_MODEL: TUNE, AGENTGLASS_DB: PATH, AGENTGLASS_DB_CLAIM: PATH, AGENTGLASS_DEBUG_PORT: PORT,
  AGENTGLASS_DESK_FD: SWITCH, AGENTGLASS_DIE_WITH_PARENT: SWITCH, AGENTGLASS_DOCTRINE: PATH, AGENTGLASS_FLIGHTPLAN_MCP_HTTP: PORT,
  AGENTGLASS_FLIGHTPLAN_MCP_TOKEN: TOKEN, AGENTGLASS_GITLOG_SIZE: TUNE, AGENTGLASS_HERMES_HOME: PATH, AGENTGLASS_INTERNAL: SWITCH,
  AGENTGLASS_JIRA_BASE: UP, AGENTGLASS_LOOPWATCH_SIZE: TUNE, AGENTGLASS_MANIFEST_BUILD: BUILD, AGENTGLASS_MANIFEST_NOW: BUILD,
  AGENTGLASS_MCP_HTTP: PORT, AGENTGLASS_MCP_TOKEN: TOKEN, AGENTGLASS_NOTIFY: SWITCH, AGENTGLASS_OPENCODE_STATS: PATH,
  AGENTGLASS_PLUGIN_DATA: PATH, AGENTGLASS_PORT: PORT, AGENTGLASS_PREFLIGHT_BIN: PATH, AGENTGLASS_PRESSURE_WINDOW_MS: TUNE,
  AGENTGLASS_PRICING: PATH, AGENTGLASS_PRICING_REFRESH: TUNE, AGENTGLASS_PRIVATE_TERMS: PATH, AGENTGLASS_PROFILE: WHO,
  AGENTGLASS_PROJECTS_DIR: PATH, AGENTGLASS_PTY_SIZE_FILE: PATH, AGENTGLASS_READ_TOKEN: TOKEN, AGENTGLASS_REMOTE__: PORT,
  AGENTGLASS_REPO_CACHE_MS: TUNE, AGENTGLASS_REPO_DEPTH: TUNE, AGENTGLASS_REPO_DIRS: PATH, AGENTGLASS_REPOS: PATH,
  AGENTGLASS_RESTORE_SETTLE_MS: TUNE, AGENTGLASS_RESUME_SAVE_MS: TUNE, AGENTGLASS_RETENTION_DAYS: TUNE, AGENTGLASS_ROLE: WHO, AGENTGLASS_ROOT: PATH,
  AGENTGLASS_SAME_ORIGIN__: PORT, AGENTGLASS_SANDBOX_USERNS_SYSCTL: PATH, AGENTGLASS_SCAN_BATCH_BYTES: TUNE, AGENTGLASS_SCAN_BATCH_LINES: TUNE, AGENTGLASS_SCAN_BATCH_MS: TUNE, AGENTGLASS_SCAN_SLICE_MS: TUNE, AGENTGLASS_SCAN_WINDOW_BYTES: TUNE,
  AGENTGLASS_SCAN_COLD_BUDGET_BYTES: TUNE, AGENTGLASS_SCAN_COLD_PAUSE_MS: TUNE, AGENTGLASS_SCAN_INTERVAL_MS: TUNE, AGENTGLASS_SCAN_MAX_LINE_BYTES: TUNE,
  AGENTGLASS_SCAN_RESYNC_BUDGET_BYTES: TUNE, AGENTGLASS_SCAN_MAX_TAILS: TUNE, AGENTGLASS_SCOPE_MAX_AGE_H: TUNE, AGENTGLASS_SCOPE_PYTHON: PATH, AGENTGLASS_SCOPES: PATH,
  AGENTGLASS_SEAT: WHO, AGENTGLASS_STALL_SAMPLER: TUNE, AGENTGLASS_SECCOMP_ARCH: PATH, AGENTGLASS_SERVER: PORT, AGENTGLASS_SERVER_LOG: PATH,
  AGENTGLASS_SETPRIV: PATH, AGENTGLASS_SETUP_SCAN_MAX: TUNE, AGENTGLASS_SETUP_SCAN_MS: TUNE, AGENTGLASS_SHELL_INTEGRATION: SWITCH,
  AGENTGLASS_SHELL_MARKERS: SWITCH, AGENTGLASS_SKILL_AUTOUPDATE: SWITCH, AGENTGLASS_SPAWN_GUARD_MS: TUNE, AGENTGLASS_STATE_DIR: PATH,
  AGENTGLASS_TASK_DIR: PATH, AGENTGLASS_TASK_PATH: PATH, AGENTGLASS_TMUX_DIR: PATH, AGENTGLASS_TMUX_IDLE_MINUTES: TUNE,
  AGENTGLASS_TMUX_PATH: PATH, AGENTGLASS_TMUX_SOCKET: PATH, AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_UI_AS: WHO,
  AGENTGLASS_UI_MCP_HTTP: PORT, AGENTGLASS_UI_MCP_TOKEN: TOKEN, AGENTGLASS_UNDERSTUDY: SWITCH, AGENTGLASS_UPDATE_LOG: PATH,
  AGENTGLASS_UPDATE_ORIGIN: BUILD, AGENTGLASS_UPDATE_SRC: BUILD, AGENTGLASS_UPDATE_STAMP: BUILD, AGENTGLASS_UPDATE_TAG: BUILD,
  AGENTGLASS_URL: PORT, AGENTGLASS_VERSION: BUILD, AGENTGLASS_WALKTHROUGH_MODEL: TUNE, AGENTGLASS_WEB_DIR: PATH,
  AGENTGLASS_BROWSER_OFF: SETBYAPP, AGENTGLASS_OPENCODE_BROWSER: PATH,
  AGENTGLASS_COCKPIT_ALLOW_HOSTS: LAUNCH, AGENTGLASS_COCKPIT_EXPOSE: LAUNCH, AGENTGLASS_COCKPIT_MAX_BYTES: LAUNCH, AGENTGLASS_COCKPIT_TRANSCRIPTS: LAUNCH,
  AGENTGLASS_FLIGHTPLAN_MCP_ALLOW_HOSTS: LAUNCH, AGENTGLASS_FLIGHTPLAN_MCP_EXPOSE: LAUNCH, AGENTGLASS_MCP_ALLOW_HOSTS: LAUNCH, AGENTGLASS_MCP_EXPOSE: LAUNCH,
  AGENTGLASS_MCP_TOOLS: LAUNCH, AGENTGLASS_UI_MCP_ALLOW_HOSTS: LAUNCH, AGENTGLASS_UI_MCP_EXPOSE: LAUNCH,
  AGENTGLASS_GH_TOKEN_FILE: PATH, AGENTGLASS_WEBHOOK: UP, AGENTGLASS_WORKER_TOKEN: TOKEN, AGENTGLASS_ZDOTDIR_ORIG: PATH,
  // The terminal relay: where the server moves terminal bytes, and the mark on the process it starts for that.
  AGENTGLASS_RELAY_CHILD: WHO,
  // The spawn broker: whether git and gh children are started by a small process, and the mark on that process.
  AGENTGLASS_SPAWNBROKER: TUNE, AGENTGLASS_BROKER_CHILD: WHO,
  // The database reader: the switch, the mark on the process the server starts for it, and the file that process opens.
  AGENTGLASS_DBREADER: TUNE, AGENTGLASS_DBREADER_CHILD: WHO, AGENTGLASS_DBREADER_PATH: PATH,
};

describe("every setting def has a control", () => {
  test("the defs are found", () => {
    expect(defIds.length).toBeGreaterThan(40);
  });
  test('data-setting="<id>" is in some web/src tsx file for every def', () => {
    /* `settingId="<id>"` is what SettingRow and Toggle render as their `data-setting-id`; a control
       that is not a row (a card, a chip strip) marks itself with `data-setting="<id>"`. */
    /* A row made once per member of a list names its id as a template, `settingId={`jira.writes.${kind}`}`:
       every id that starts with the template's literal part, and has something after it, is that row's. */
    /* A row drawn from a spec list: `{ id: "<id>", kind: ... }` in doorSpecs.ts, which DoorValueRow renders
       with `settingId={spec.id}` and `<DoorCard>` mounts. Only counted while that rendering is in place. */
    const specSrc = read("web/src/components/orchestration/doorSpecs.ts");
    const rowRender = read("web/src/components/orchestration/DoorValueRow.tsx").includes("settingId={spec.id}");
    const mounted = webSource.includes("<DoorCard ");
    const limitsSrc = read("shared/envLimits.ts");
    const limitsMounted = webSource.includes("<EnvLimitsCard ") && read("web/src/components/orchestration/DoorValueRow.tsx").includes("ENV_LIMITS.map");
    const rowSpecs = new Set(rowRender && mounted ? [...specSrc.matchAll(/\{ id: "([^"]+)", kind:/g)].map((m) => m[1]!) : []);
    /* A row drawn from the Advanced page's list: `{ id: "<id>", key: ... }` in advancedRows.ts, which advanced.tsx
       renders with `data-setting={id}`. Only counted while that rendering is in place. */
    const advRender = read("web/src/components/settings/pages/advanced.tsx").includes("data-setting={id}");
    if (advRender) for (const m of read("web/src/components/settings/pages/advancedRows.ts").matchAll(/\{ id: "([^"]+)", key:/g)) rowSpecs.add(m[1]!);
    /* A row drawn from the Inspect page's list: `{ id: "<id>", label: ... }` in inspectRows.ts, which inspect.tsx
       renders with `settingId={r.id}`. Only counted while that rendering is in place. */
    const inspRender = read("web/src/components/settings/pages/inspect.tsx").includes("settingId={r.id}");
    if (inspRender) for (const m of read("web/src/components/settings/pages/inspectRows.ts").matchAll(/\{ id: "([^"]+)", label:/g)) rowSpecs.add(m[1]!);
    if (rowRender && limitsMounted) for (const m of limitsSrc.matchAll(/id: "(limits\.[^"]+)", kind:/g)) rowSpecs.add(m[1]!);
    /* A row drawn from a page's own DoorSpec list (`{ id: "<id>", kind: ... }`), which DoorRows.tsx renders with `settingId={spec.id}`. */
    if (read("web/src/components/settings/pages/DoorRows.tsx").includes("settingId={spec.id}")) {
      for (const page of ["FlightPlanPage", "FlowReviewPage", "PolarisPage"]) {
        for (const m of read(`web/src/components/settings/pages/${page}.tsx`).matchAll(/\{ id: "([^"]+)", kind:/g)) rowSpecs.add(m[1]!);
      }
    }
    const templates = [...webSource.matchAll(/settingId=\{`([^`$]+)\$\{/g)].map((m) => m[1]!);
    const missing = defIds.filter((id) => !webSource.includes(`data-setting="${id}"`) && !webSource.includes(`settingId="${id}"`)
      && !templates.some((t) => id.startsWith(t) && id.length > t.length) && !rowSpecs.has(id));
    expect(missing, `${missing.length} setting def(s) without a control; add data-setting="<id>" to the control:\n${missing.join("\n")}`).toEqual([]);
  });
});

describe("every worker restriction is a def", () => {
  test("each switchable command has workers.commands.<command>", () => {
    const missing = SWITCHABLE_COMMANDS.map((c) => `workers.commands.${c.replace(/ /g, "-")}`).filter((id) => !defIds.includes(id));
    expect(missing, `no setting for: ${missing.join(", ")}`).toEqual([]);
  });
  test("each WORKER_DENIED door but the browser has workers.appDoors.<door>", () => {
    const missing = WORKER_DENIED.filter((d) => d !== "agentglass-browser").map((d) => `workers.appDoors.${d}`).filter((id) => !defIds.includes(id));
    expect(missing, `no setting for: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("every AGENTGLASS_* name is a def or plumbing", () => {
  const names = new Set<string>();
  for (const f of [...files("server/src", "**/*.ts"), ...files("bin", "*")]) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/AGENTGLASS_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  test("the scan finds names", () => {
    expect(names.size).toBeGreaterThan(100);
  });
  test("a name with no def and no plumbing clause fails", () => {
    const loose = [...names].filter((n) => !(n in PLUMBING) && !settingsSource.includes(n)).sort();
    expect(loose, `${loose.length} limit(s) with no setting: give each a def next to its page's control, or, if it only locates/identifies/tunes, a clause in PLUMBING:\n${loose.join("\n")}`).toEqual([]);
  });
  test("a plumbing entry that is no longer in the tree, or became a def, is removed", () => {
    const stale = Object.keys(PLUMBING).filter((n) => !names.has(n) || settingsSource.includes(n));
    expect(stale, `stale PLUMBING entries: ${stale.join(", ")}`).toEqual([]);
  });
});
