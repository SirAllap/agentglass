/*
 * The settings the SERVER holds, as definitions the settings door applies
 * (settingsDoor.ts). Each wraps the read and the write its own Settings page
 * already uses, so a change through the door is validated and stored exactly as
 * the page's save would be, and the two cannot disagree about a valid value.
 *
 * What an agent may do with each is shared/settingClass.ts, not here.
 *
 * Not here, on purpose: the tmux choice and its config text, the understudy,
 * privacy and retention, the remote pairing, plugin settings (a plugin may
 * declare a secret field), and every token. The ceiling of this list: those are
 * still changed only on their own pages.
 */
import type { Budget, EngineReadiness } from "../../shared/types.ts";
import { writeLaunchBase } from "./agentRulesStore.ts";
import { validatePolicy } from "../../shared/orchestration.ts";
import { validatePresetList, type PresetFile } from "../../shared/preset.ts";
import { isLaunchMode, parseDenyRules, parseFlagLine } from "../../shared/launchModes.ts";
import { AGENT_PROVIDERS, ENGINE_IDS } from "../../shared/agentKinds.ts";
import { WORKER_ROLES } from "../../shared/workerRoles.ts";
import { GATE_ANSWERERS, GATE_ON_TIMEOUT, isOneOf } from "../../shared/agentDefaults.ts";
import {
  launchMode, launchDeny, launchFlagOverrides, writeLaunchFlagOverrides, seatWakeHours, writeSeatSettings, workerRoles, writeWorkerRole,
  readBudgets, writeBudgets, policyRoots, lanternNudge, lanternNudgeMinutes, lanternWatch, lanternWatchMinutes, cacheTtlMinutes,
  gateAnswerer, gateOnTimeout, writeAgentDefaults,
  writeLanternSettings, LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN, phoneAlerts, writePhoneAlerts,
  terminalRelaySetting, writeTerminalRelay,
} from "./config.ts";
import { relayHeldByEnv } from "./relay/wire.ts";
import { agentsTrusted, agentsTrustSetAt, writeAgentsTrusted } from "./agentTrust.ts";
import { cleanAllowList, cleanVerbGroups } from "../../shared/browserLimits.ts";
import { storedAllowList, workerVerbGroups, writeBrowserLimit } from "./browserLimits.ts";
import { browserWorkersNow, saveBrowserWorkers, validateBrowserWorkers } from "./browseraccess.ts";
import type { BrowserWorkers } from "../../shared/browserWorkers.ts";
import { readPolicy, writePolicy } from "./orchestration.ts";
import { checkAccountDir } from "./claudeAccount.ts";
import {
  REVIEW_ROUNDS_MAX, REVIEW_ROUNDS_MIN, checkSecondReviewer, isReviewWho, secondFromStored,
} from "../../shared/reviewSettings.ts";
import { envLimitHeldBy, readPolaris, readStoredPolaris, scopeConfig, storedEnvLimit, writeEnvLimit, writePolaris, writeScopeMemoryMax } from "./config.ts";
import { SWITCHABLE_COMMANDS } from "../../shared/workerRoles.ts";
import { ENV_LIMITS, type EnvLimit } from "../../shared/envLimits.ts";
import { validSize } from "./scopes.ts";
import { DOOR_IDS, checkDoor, withDoor, withEnabled, type DoorValue } from "../../shared/polaris.ts";
import { CLEANUP_MODES, EMPTY_CLEANUP_CONFIG, parseCleanupConfig, parseCleanupEvidenceRoots, parseCleanupInclude, parseCleanupOtherFolders, type CleanupConfig } from "./cleanup.ts";
import { BUILDER_MODELS } from "../../shared/builderModel.ts";
import * as Seat from "./seat.ts";
import { ruleRoot } from "./agentRulesStore.ts";
import { APP, APP_DOORS, REVIEWS, UNIX_SOCKETS, getSetting, hasSetting, markHeld, putSetting, type SettingKey } from "./preflightStore.ts";
import { configuredMcpServerNames } from "./workerMcp.ts";
import { MCP_READONLY_DENY, mcpModesOf } from "../../shared/mcpReadonly.ts";
import { preflightModel } from "./flightPlan.ts";
import { hookStatus, applyGate } from "./hooksetup.ts";
import { masterEnabled, setMaster, listPlugins, enablePlugin, disablePlugin, setPluginUnboxedConsent } from "./plugins.ts";
import { jiraWriteEnabled, jiraWriteKinds, setJiraWrites, setJiraWriteKind, type JiraWriteKind } from "./jira.ts";
import { clickupWriteEnabled } from "./clickup.ts";
import { RETENTION_DAYS, setRetentionDays, CLICKUP_CARD_DAYS, setClickupCardDays, UNDERSTUDY_STUB_DAYS, setLedgerStubDays } from "./retention.ts";
import { setWritesAllowed } from "./clickupviews.ts";
import { keyringEnabled } from "./keyring.ts";
import { setKeyringEnabled } from "./keyringSwitch.ts";
import { clickupPrefs, setClickupPrefs } from "./clickupPrefs.ts";
import { clickupWritesByRepo, setClickupWrites, setTrackerChoice, trackerChoiceFor } from "./trackerProjects.ts";
import { repoNameOf } from "./prs.ts";
import { TRACKER_CHOICES } from "../../shared/providers.ts";
import type { Applied, ServerSettingDef } from "./settingsDoor.ts";

type Check = { value: unknown } | { error: string };

const put = (root: string | undefined, key: SettingKey, v: unknown): Applied => { putSetting(root!, key, v as string | number | boolean | string[]); return { ok: true }; };
/** A project's cleanup settings; nothing stored (or something unreadable) is the empty config, which skips every repo-specific step. */
export function cleanupConfigOf(root: string): CleanupConfig {
  try {
    const raw = String(getSetting(root, "cleanup.config"));
    const c = raw ? parseCleanupConfig(JSON.parse(raw)) : null;
    const inc = parseCleanupInclude(getSetting(root, "cleanup.include"));
    const roots = parseCleanupEvidenceRoots(getSetting(root, "cleanup.evidenceRoots"));
    const other = parseCleanupOtherFolders(getSetting(root, "cleanup.otherFolders"));
    return {
      ...EMPTY_CLEANUP_CONFIG, ...(c && "value" in c ? c.value : {}), ...("value" in inc ? { include: inc.value } : {}),
      ...("value" in roots ? { evidenceRoots: roots.value } : {}), ...("value" in other ? { otherFolders: other.value } : {}),
      orphanAutoRemove: getSetting(root, "cleanup.orphanAutoRemove") === true,
      moveCard: getSetting(root, "cleanup.moveCard") === true,
      moveCardStatus: String(getSetting(root, "cleanup.moveCardStatus") ?? ""),
    };
  } catch { return EMPTY_CLEANUP_CONFIG; }
}
const capUsd = (raw: unknown): Check => (typeof raw === "number" && raw > 0 && raw <= 1000 ? { value: raw } : { error: "a number above 0 and up to 1000" });
const bool = (raw: unknown): Check => (typeof raw === "boolean" ? { value: raw } : { error: "true or false" });
const minutes = (lo: number, hi: number) => (raw: unknown): Check => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? { value: Math.min(hi, Math.max(lo, Math.round(n))) } : { error: `a number from ${lo} to ${hi}` };
};
/** A config write's answer as the door wants it. */
/** What the row shows: the stored value in the shape the page edits. A switch not yet stored reads off. */
function envLimitValue(l: EnvLimit): boolean | number | string {
  const stored = storedEnvLimit(l.env);
  if (l.kind === "switch") return stored === "1";
  if (l.kind === "number") return stored === "" ? 0 : Number(stored);
  return stored;
}
function validateEnvLimit(l: EnvLimit, raw: unknown): Check {
  if (l.kind === "switch") return bool(raw);
  if (l.kind === "number") {
    return typeof raw === "number" && Number.isFinite(raw) && raw >= (l.min ?? 0) && raw <= (l.max ?? Number.MAX_SAFE_INTEGER)
      ? { value: raw } : { error: `a number from ${l.min ?? 0} to ${l.max ?? "any"}` };
  }
  return typeof raw === "string" && raw.length <= 2000 ? { value: raw } : { error: "text, or empty for none" };
}
const saved = (r: { ok: boolean; error?: string }): Applied => (r.ok ? { ok: true } : { ok: false, error: r.error ?? "could not save it" });
/** The repository a project's checkout is, or null when `--root` names no checkout. */
const repoOfRoot = (root?: string): string | null => (root ? repoNameOf(root) : null);
const NOT_A_CHECKOUT = "the project named by --root is not a checkout of a repository on this machine (its remote, upstream or origin), so there is no repository to keep this for";
const done = async (f: () => unknown): Promise<Applied> => {
  try { await f(); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message || "could not save it" }; }
};

/**
 * A budget list the way /budgets/set takes it, or why not. Refused on the way
 * in, not silently dropped: readBudgets() skips what it cannot use, so a bad row
 * accepted here would vanish on the next read and look exactly like a save that
 * did nothing. A limit is a NUMBER, not something Number() can be talked into.
 */
export function cleanBudgets(raw: unknown): Budget[] | string {
  if (!Array.isArray(raw)) return "expected a list of budgets";
  const clean: Budget[] = [];
  for (const b of raw as Partial<Budget>[]) {
    if (!b || typeof b !== "object") return "that is not a budget";
    const limit = b.limit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return "a budget needs a limit above zero";
    if (b.period !== "day" && b.period !== "week" && b.period !== "month") return "a budget needs a period of day, week or month";
    clean.push({ root: typeof b.root === "string" ? b.root : "", model: typeof b.model === "string" ? b.model : "", limit, period: b.period });
  }
  return clean;
}

/**
 * What switching a plugin on approves, as card lines: the record the server keeps
 * of its manifest, as JSON, never its description (the author's prose). The
 * fingerprint is in it, so a manifest that changed between the ask and the
 * approval reads differently and nothing applies.
 */
export function declaration(name: string): string[] {
  const p = listPlugins().find((q) => q.name === name);
  if (!p) return ["no such plugin"];
  const already = !!p.approvedFingerprint && p.approvedFingerprint === p.fingerprint;
  return [
    already ? "its declaration is the one already approved" : "switching it on approves this declaration:",
    `publisher: ${JSON.stringify(p.publisher)}`,
    `source: ${JSON.stringify(p.source)}`,
    `scope: ${JSON.stringify(p.scope)}`,
    `draws: ${JSON.stringify(p.contributes ?? {})}`,
    `box: ${JSON.stringify(p.sandbox ?? null)}`,
    `fingerprint: ${JSON.stringify(p.fingerprint)}`,
  ];
}

export interface ServerSettingsEnv {
  terminalEnabled: boolean;
  budgetWrites: boolean;
  /** Told after the orchestration policy changes: its switches and the chairs settle again. */
  policyChanged(): void;
  /** This machine's engine readiness. Left out in tests, which must not probe a CLI. */
  engineReadiness?(): Promise<readonly EngineReadiness[]>;
}

/** One kind of Jira write, as its own switch under the master one (server/src/jira.ts, writeRefusal). */
const jiraKindSetting = (d: { id: string; kind: JiraWriteKind; label: string }): ServerSettingDef =>
  ({ id: d.id, page: "jira", label: d.label, type: "boolean", read: () => jiraWriteKinds()[d.kind], validate: bool, apply: (v) => done(() => setJiraWriteKind(d.kind, v === true)) });

/** A project's own presets, or the machine-wide ones. A hand-edited list that does not validate reads as none, like every policy file. */
export function storedPresets(root: string | undefined): PresetFile[] {
  try {
    const raw = String(getSetting(root ?? APP, "orchestration.presets"));
    if (!raw) return [];
    const v = validatePresetList(JSON.parse(raw));
    return v.ok ? v.value : [];
  } catch { return []; }
}

export function serverSettingDefs(env: ServerSettingsEnv): ServerSettingDef[] {
  const seat = (root?: string) => (root ? Seat.seatRow(root) : null);
  const defs: ServerSettingDef[] = [
    {
      id: "orchestration.policy", page: "orchestration", label: "Orchestration policy", type: "json",
      read: (root) => readPolicy(root).policy,
      /* null drops a project's own policy, so the global one applies there again:
         the diff then reads against what will be in force, not against nothing. */
      validate: (raw, root) => {
        if (raw === null) return root && policyRoots().includes(root) ? { value: null } : { error: "null removes a project's own policy, and this has none" };
        const v = validatePolicy(raw);
        return v.ok ? { value: v.value } : { error: v.error };
      },
      effective: (v) => (v === null ? readPolicy(undefined).policy : v),
      apply: (v, root) => { const r = writePolicy(root, v); if (r.ok) env.policyChanged(); return r.ok ? { ok: true } : { ok: false, error: r.error }; },
    },
    {
      id: "orchestration.presets", page: "orchestration", label: "Presets: named setups a person saves, shares and applies again (validated .agxpreset files)", scoped: true, type: "json",
      read: (root) => storedPresets(root),
      validate: (raw) => validatePresetList(raw),
      apply: (v, root) => put(root ?? APP, "orchestration.presets", JSON.stringify(v)),
      isSet: (root) => hasSetting(root ?? APP, "orchestration.presets"),
    },
    {
      id: "orchestration.review.who", page: "orchestration", label: "Who reviews and checks: the orchestrator never reads code or runs tests, makes a second review, or is the reviewer", scoped: true, type: "string",
      read: (root) => getSetting(root ?? APP, "orchestration.review.who"),
      validate: (raw) => (isReviewWho(raw) ? { value: raw } : { error: "never, second or is" }),
      apply: (v, root) => put(root ?? APP, "orchestration.review.who", v),
      isSet: (root) => hasSetting(root ?? APP, "orchestration.review.who"),
    },
    {
      id: "orchestration.review.rounds", page: "orchestration", label: "The most rounds of the Builder to Reviewer loop before it stops and asks", scoped: true, type: "number",
      read: (root) => getSetting(root ?? APP, "orchestration.review.rounds"),
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= REVIEW_ROUNDS_MIN && raw <= REVIEW_ROUNDS_MAX ? { value: raw } : { error: `a whole number from ${REVIEW_ROUNDS_MIN} to ${REVIEW_ROUNDS_MAX}` }),
      apply: (v, root) => put(root ?? APP, "orchestration.review.rounds", v),
      isSet: (root) => hasSetting(root ?? APP, "orchestration.review.rounds"),
    },
    {
      id: "orchestration.review.second", page: "orchestration", label: "A second reviewer, on another engine and model", scoped: true, type: "json",
      read: (root) => secondFromStored(getSetting(root ?? APP, "orchestration.review.second")),
      validate: async (raw) => {
        const checked = checkSecondReviewer(raw);
        if ("error" in checked || !checked.value) return checked;
        const engines = await (env.engineReadiness ?? (async () => (await Seat.engineReport()).engines))();
        return checkSecondReviewer(checked.value, engines);
      },
      apply: (v, root) => put(root ?? APP, "orchestration.review.second", v === null ? "" : JSON.stringify(v)),
      isSet: (root) => hasSetting(root ?? APP, "orchestration.review.second") && getSetting(root ?? APP, "orchestration.review.second") !== "",
    },
    ...WORKER_ROLES.map((role): ServerSettingDef => ({
      id: `agents.role.${role.id}`, page: "engines", label: `${role.id} role: engine and model`, type: "json",
      read: () => workerRoles()[role.id],
      validate: (raw) => {
        const c = raw as { provider?: unknown; model?: unknown } | null;
        return c && typeof c === "object" && typeof c.provider === "string" ? { value: { provider: c.provider, model: typeof c.model === "string" ? c.model.trim() : "" } } : { error: 'an object {"provider": "...", "model": "..."}' };
      },
      apply: (v) => saved(writeWorkerRole(role.id, v)),
    })),
    {
      /* The stored half of the relay switch; the server reads it once, at boot (index.ts, relayWanted).
         AGENTGLASS_TERMRELAY=1 or =0 in the server's environment wins, and then a write here would be a
         choice that does nothing: refused with the reason, the way retention refuses under its variable. */
      id: "terminal.relay", page: "terminal", label: "Terminals run in a process of their own (applies at the next app start)", type: "boolean",
      read: () => terminalRelaySetting(),
      validate: bool,
      apply: (v) => {
        const held = relayHeldByEnv(process.env.AGENTGLASS_TERMRELAY);
        if (held) return { ok: false, error: `AGENTGLASS_TERMRELAY=${held} is set in the environment this server started from, and it wins: unset it to choose here` };
        return saved(writeTerminalRelay(v === true));
      },
    },
    {
      id: "launch.mode", page: "terminal", label: "Permission mode agents launch in", type: "string",
      read: () => launchMode(),
      validate: (raw) => (isLaunchMode(raw) ? { value: raw } : { error: "default, acceptEdits, auto or bypassPermissions" }),
      apply: (v) => saved(writeLaunchBase({ mode: v })),
    },
    ...AGENT_PROVIDERS.filter((k) => k.id !== "claude").map((k): ServerSettingDef => ({
      id: `launch.flags.${k.id}`, page: "engines", label: `${k.title}: launch flags per permission mode`, type: "json",
      read: () => launchFlagOverrides()[k.id] ?? {},
      validate: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "an object of mode: flags" };
        const out: Record<string, string[]> = {};
        for (const [mode, v] of Object.entries(raw)) {
          const p = isLaunchMode(mode) ? parseFlagLine(Array.isArray(v) ? v.map(String).join(" ") : typeof v === "string" ? v : "\n") : null;
          if (!p) return { error: `not a permission mode: ${mode.slice(0, 20)}` };
          if (!p.ok) return { error: `${mode}: ${p.error}` };
          out[mode] = p.argv;
        }
        return { value: out };
      },
      apply: (v) => saved(writeLaunchFlagOverrides(k.id, v)),
    })),
    {
      id: "launch.deny", page: "terminal", label: "Tools every launched agent is denied", type: "json",
      read: () => launchDeny(),
      validate: (raw) => {
        const text = Array.isArray(raw) ? raw.map(String).join("\n") : typeof raw === "string" ? raw : null;
        if (text === null) return { error: "a list of rules" };
        const p = parseDenyRules(text);
        return p.bad.length ? { error: `not a rule: ${p.bad[0]}` } : { value: p.rules };
      },
      apply: (v) => saved(writeLaunchBase({ deny: v })),
    },
    {
      id: "setup.done", page: "onboarding", label: "The first run is finished", type: "boolean",
      read: () => getSetting(APP, "setup.done"), validate: bool, apply: (v) => put(APP, "setup.done", v),
      isSet: () => hasSetting(APP, "setup.done"),
    },
    {
      id: "setup.inProgress", page: "onboarding", label: "A setup run is open (the wizard survives a reload)", type: "boolean",
      read: () => getSetting(APP, "setup.inProgress"), validate: bool, apply: (v) => put(APP, "setup.inProgress", v),
    },
    {
      id: "setup.tutorial", page: "onboarding", label: "The tutorial cards already read", type: "string",
      read: () => getSetting(APP, "setup.tutorial"),
      validate: (raw) => (typeof raw === "string" && raw.length <= 200 && !raw.includes("\0") ? { value: raw } : { error: "a comma list of card ids" }),
      apply: (v) => put(APP, "setup.tutorial", v),
    },
    {
      id: "setup.agent", page: "onboarding", label: "The agent a first terminal starts", type: "string",
      read: () => getSetting(APP, "setup.agent"),
      validate: (raw) => (typeof raw === "string" && ENGINE_IDS.includes(raw as never) ? { value: raw } : { error: `an engine id: ${ENGINE_IDS.join(", ")}` }),
      apply: (v) => put(APP, "setup.agent", v),
    },
    {
      id: "flightPlan.enabled", page: "orchestration", label: "Flight plan (the view where a plan is written, reviewed and launched)", type: "boolean",
      read: () => getSetting(APP, "flightPlan.enabled"), validate: bool, apply: (v) => put(APP, "flightPlan.enabled", v),
    },
    {
      id: "flightPlan.mockupGuide", page: "orchestration", label: "The mockup style guide a flight plan's author reads (a file path, or empty)", type: "string",
      read: () => getSetting(APP, "flightPlan.mockupGuide"),
      validate: (raw) => (raw === "" || (typeof raw === "string" && raw.length <= 500 && raw.startsWith("/") && !raw.includes("\0")) ? { value: raw } : { error: "an absolute path, or empty" }),
      apply: (v) => put(APP, "flightPlan.mockupGuide", v),
    },
    {
      id: "flightPlan.builder.permissions", page: "orchestration", label: "The permission mode a launched builder starts in (default, auto or bypassPermissions)", type: "string",
      read: () => getSetting(APP, "flightPlan.builder.permissions"),
      validate: (raw) => (raw === "default" || raw === "auto" || raw === "bypassPermissions" ? { value: raw } : { error: "default (ask), auto or bypassPermissions" }),
      apply: (v) => put(APP, "flightPlan.builder.permissions", v),
    },
    {
      id: "agents.permissionMode", page: "orchestration", label: "Permission mode a worker role starts in (dontAsk or bypassPermissions)", scoped: true, type: "string",
      read: (root) => getSetting(root ?? APP, "agents.permissionMode"),
      // Only a mode that never draws a dialog is valid: nobody sits at a worker's pane.
      validate: (raw) => (raw === "" || raw === "dontAsk" || raw === "bypassPermissions" ? { value: raw } : { error: "dontAsk or bypassPermissions" }),
      apply: (v, root) => put(root ?? APP, "agents.permissionMode", v),
      isSet: (root) => hasSetting(root ?? APP, "agents.permissionMode") && getSetting(root ?? APP, "agents.permissionMode") !== "",
    },
    {
      id: "workers.claudeConfigDir", page: "orchestration", label: "Claude Code account this project's agents use, as a config folder; empty is the default", scoped: true, type: "string",
      read: (root) => getSetting(root ?? APP, "workers.claudeConfigDir"),
      validate: (raw) => checkAccountDir(raw),
      apply: (v, root) => put(root ?? APP, "workers.claudeConfigDir", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.claudeConfigDir") && getSetting(root ?? APP, "workers.claudeConfigDir") !== "",
    },
    {
      id: "workers.unixSockets", page: "orchestration", label: "Unix sockets a worker's sandbox may reach (off or all)", scoped: true, type: "string",
      read: (root) => getSetting(root ?? APP, "workers.unixSockets"),
      validate: (raw) => ((UNIX_SOCKETS as readonly unknown[]).includes(raw) ? { value: raw } : { error: "off or all" }),
      apply: (v, root) => put(root ?? APP, "workers.unixSockets", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.unixSockets"),
    },
    {
      id: "workers.projectSkills", page: "orchestration", label: "A worker role's turn loads the checkout's own skills and commands", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "workers.projectSkills"), validate: bool, apply: (v, root) => put(root ?? APP, "workers.projectSkills", v),
    },
    {
      id: "workers.noClaude", page: "orchestration", label: "No Claude in workers: a worker role set to Claude starts on the project's other engine, or is refused when none is ready", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "workers.noClaude"), validate: bool, apply: (v, root) => put(root ?? APP, "workers.noClaude", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.noClaude"),
    },
    {
      id: "workers.mcpServers", page: "orchestration", label: "The person's configured MCP servers a worker role's turn may use, and whether each is read-only or may write", scoped: true, type: "json",
      // Normalized, never the raw stored shape: a project that chose servers
      // before per-server modes existed has a plain list there still, and
      // `mcpModesOf` reads each one as "all" — exactly what it had — so the
      // door's `prev` for an agent's change (shared/settingClass.ts
      // `mcpNarrows`) and the page both see the same map a fresh write would.
      read: (root) => mcpModesOf(getSetting(root ?? APP, "workers.mcpServers")),
      validate: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "a map of configured MCP server name to \"readOnly\" or \"all\"" };
        const known = configuredMcpServerNames();
        const out: Record<string, "readOnly" | "all"> = {};
        for (const [name, mode] of Object.entries(raw as Record<string, unknown>)) {
          if (!known.includes(name)) return { error: `unknown MCP server ${JSON.stringify(name)}: one of ${known.join(", ") || "(none configured)"}` };
          if (mode !== "readOnly" && mode !== "all") return { error: `${name}: "readOnly" or "all"` };
          if (mode === "readOnly" && !MCP_READONLY_DENY[name]) return { error: `${name}: Read-only is only offered for a server this app knows how to hold to reading` };
          out[name] = mode;
        }
        return { value: out };
      },
      apply: (v, root) => put(root ?? APP, "workers.mcpServers", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.mcpServers") && Object.keys(mcpModesOf(getSetting(root ?? APP, "workers.mcpServers"))).length > 0,
    },
    {
      id: "workers.plannerWrite", page: "orchestration", label: "The built-in scout (planner) may write its own worktree and .agx-tmp (AGENTGLASS_PLANNER_WRITE holds it)", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "workers.plannerWrite") === true, validate: bool,
      apply: (v, root) => put(root ?? APP, "workers.plannerWrite", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.plannerWrite"),
    },
    {
      /* Read-only: the person's own list, for the Settings page to offer as
         choices. An agent cannot set what MCP servers are configured, so this
         setting has no `apply` — a write is refused rather than silently kept. */
      id: "workers.mcpServers.available", page: "orchestration", label: "The person's configured MCP servers (read-only)", type: "json",
      read: () => configuredMcpServerNames(),
      validate: () => ({ error: "this list is read from ~/.claude.json, and is not written here" }),
      apply: () => ({ ok: false, error: "this list is read from ~/.claude.json, and is not written here" }),
    },
    {
      id: "flightPlan.builder.strongModel", page: "orchestration", label: "The model a sensitive or L plan's builder starts on (haiku, sonnet or opus)", type: "string",
      read: () => getSetting(APP, "flightPlan.builder.strongModel"),
      validate: (raw) => (BUILDER_MODELS.includes(raw as never) ? { value: raw } : { error: `one of ${BUILDER_MODELS.join(", ")}` }),
      apply: (v) => put(APP, "flightPlan.builder.strongModel", v),
    },
    {
      id: "flightPlan.builderBase", page: "orchestration", label: "Where a launched builder's worktree is cut from (local trunk or origin)", type: "string",
      read: () => getSetting(APP, "flightPlan.builderBase"),
      validate: (raw) => (raw === "local" || raw === "remote" ? { value: raw } : { error: "local or remote" }),
      apply: (v) => put(APP, "flightPlan.builderBase", v),
    },
    {
      id: "flightPlan.pilot", page: "orchestration", label: "Who flies a project's plans (manual, copilot or autopilot)", scoped: true, type: "string",
      read: (root) => getSetting(root ?? APP, "flightPlan.pilot"),
      validate: (raw) => (raw === "manual" || raw === "copilot" || raw === "autopilot" ? { value: raw } : { error: "manual, copilot or autopilot" }),
      apply: (v, root) => put(root ?? APP, "flightPlan.pilot", v),
      isSet: (root) => hasSetting(root ?? APP, "flightPlan.pilot"),
    },
    {
      id: "flightPlan.project.enabled", page: "orchestration", label: "Use Flight plan in a project (off: no plan is written, no Preflight runs, nothing waits)", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "flightPlan.project.enabled"),
      validate: bool, apply: (v, root) => put(root ?? APP, "flightPlan.project.enabled", v),
      isSet: (root) => hasSetting(root ?? APP, "flightPlan.project.enabled"),
    },
    {
      id: "flightPlan.preflight.reviews", page: "orchestration", label: "What a Preflight reviews: any of plan, taskDone, pr", scoped: true, type: "json",
      read: (root) => getSetting(root ?? APP, "flightPlan.preflight.reviews"),
      validate: (raw) => {
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : null;
        return list && list.every((x) => (REVIEWS as readonly unknown[]).includes(x)) ? { value: [...new Set(list)] } : { error: "a list of plan, taskDone, pr" };
      },
      apply: (v, root) => put(root ?? APP, "flightPlan.preflight.reviews", v),
      isSet: (root) => hasSetting(root ?? APP, "flightPlan.preflight.reviews"),
    },
    {
      id: "flightPlan.preflight.sizes", page: "orchestration", label: "Which plan sizes are plans, and get a Preflight (L, or ML for M and L): another size goes straight to a worker", type: "string",
      read: () => getSetting(APP, "flightPlan.preflight.sizes"),
      validate: (raw) => (raw === "L" || raw === "ML" ? { value: raw } : { error: "L or ML" }),
      apply: (v) => put(APP, "flightPlan.preflight.sizes", v),
    },
    {
      id: "flightPlan.preflight.secondLooks", page: "orchestration", label: "Reviews after a fix, per plan (0 to 2)", type: "number",
      read: () => getSetting(APP, "flightPlan.preflight.secondLooks"),
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 2 ? { value: raw } : { error: "0, 1 or 2" }),
      apply: (v) => put(APP, "flightPlan.preflight.secondLooks", v),
    },
    {
      id: "flightPlan.budget.dailyUsd", page: "orchestration", label: "The most Flight plan may spend in a day, in dollars", type: "number",
      read: () => getSetting(APP, "flightPlan.budget.dailyUsd"),
      validate: capUsd, apply: (v) => put(APP, "flightPlan.budget.dailyUsd", v),
    },
    {
      id: "flightPlan.budget.weeklyUsd", page: "orchestration", label: "The most Flight plan may spend in a week, in dollars", type: "number",
      read: () => getSetting(APP, "flightPlan.budget.weeklyUsd"),
      validate: capUsd, apply: (v) => put(APP, "flightPlan.budget.weeklyUsd", v),
    },
    {
      id: "flightPlan.maxFlying", page: "orchestration", label: "How many launched builders fly at once (1 to 3)", type: "number",
      read: () => getSetting(APP, "flightPlan.maxFlying"),
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 3 ? { value: raw } : { error: "1, 2 or 3" }),
      apply: (v) => put(APP, "flightPlan.maxFlying", v),
    },
    {
      id: "flightPlan.autopilot.askOnLarge", page: "orchestration", label: "Autopilot asks the person before Go on a large plan", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "flightPlan.autopilot.askOnLarge"),
      validate: bool, apply: (v, root) => put(root ?? APP, "flightPlan.autopilot.askOnLarge", v),
      isSet: (root) => hasSetting(root ?? APP, "flightPlan.autopilot.askOnLarge"),
    },
    {
      id: "flightPlan.autopilot.askOnSensitive", page: "orchestration", label: "Autopilot asks the person before Go on a sensitive plan", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "flightPlan.autopilot.askOnSensitive"),
      validate: bool, apply: (v, root) => put(root ?? APP, "flightPlan.autopilot.askOnSensitive", v),
      isSet: (root) => hasSetting(root ?? APP, "flightPlan.autopilot.askOnSensitive"),
    },
    {
      id: "flightPlan.held", page: "orchestration", label: "Hold a project's flight plans: no new Go, launches frozen", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(ruleRoot(root), "flightPlan.held") : false),
      validate: bool, apply: (v, root) => { markHeld(ruleRoot(root!), v as boolean, null); return put(ruleRoot(root!), "flightPlan.held", v); },
      isSet: (root) => hasSetting(ruleRoot(root), "flightPlan.held"),
    },
    {
      id: "flightPlan.preflight.model", page: "orchestration", label: "The model a Preflight reviews with: the Reviewer role's model, chosen in Orchestration", scoped: true, type: "string",
      read: (root) => preflightModel(root ?? APP),
      validate: (raw) => {
        if (!(typeof raw === "string" && raw.length <= 120 && /^[A-Za-z0-9][\w.\[\]-]*$/.test(raw))) return { error: "a model name, one word" };
        const role = workerRoles().reviewer;
        return role.provider === "claude" ? { value: raw } : { error: `the Reviewer role runs ${role.provider}: its engine and model are chosen in Orchestration` };
      },
      apply: (v) => saved(writeWorkerRole("reviewer", { provider: workerRoles().reviewer.provider, model: v })),
      isSet: (root) => workerRoles().reviewer.model !== "",
    },
    {
      id: "flightPlan.preflight.costCapUsd", page: "orchestration", label: "The most one Preflight may spend, in dollars (above 0, up to 5)", scoped: true, type: "number",
      read: (root) => (root ? getSetting(root, "flightPlan.preflight.costCapUsd") : 0.5),
      validate: (raw) => (typeof raw === "number" && raw > 0 && raw <= 5 ? { value: raw } : { error: "a number above 0 and up to 5" }),
      apply: (v, root) => put(root, "flightPlan.preflight.costCapUsd", v),
    },
    {
      id: "flightPlan.preflight.fileCapBytes", page: "orchestration", label: "Bytes a plan-named file with no cited line goes whole up to, before only its head is sent (0: no cap, always whole)", scoped: true, type: "number",
      read: (root) => (root ? getSetting(root, "flightPlan.preflight.fileCapBytes") : 0),
      validate: (raw) => (typeof raw === "number" && raw >= 0 && Number.isFinite(raw) ? { value: raw } : { error: "a number, 0 or above" }),
      apply: (v, root) => put(root, "flightPlan.preflight.fileCapBytes", v),
    },
    {
      id: "cleanup.config", page: "orchestration", label: "What cleaning up after a merged pull request may remove", scoped: true, type: "json",
      read: (root) => { const { include: _kinds, evidenceRoots: _roots, otherFolders: _other, orphanAutoRemove: _auto, ...body } = root ? cleanupConfigOf(root) : EMPTY_CLEANUP_CONFIG; return body; },
      validate: (raw) => parseCleanupConfig(raw),
      apply: (v, root) => put(root, "cleanup.config", JSON.stringify(v)),
      isSet: (root) => hasSetting(root, "cleanup.config"),
    },
    {
      id: "polaris.enabled", page: "orchestration", label: "Polaris: pull request abilities of the orchestrator", scoped: true, type: "boolean",
      read: (root) => readPolaris(root).settings.enabled,
      validate: bool,
      apply: (v, root) => saved(writePolaris(root, withEnabled(readStoredPolaris(root), v === true))),
      isSet: (root) => typeof readStoredPolaris(root)?.enabled === "boolean",
      layer: (root) => readPolaris(root).enabledLayer,
    },
    {
      id: "polaris.botReviewers", page: "orchestration", label: "Polaris: the bot logins whose review and check summaries are counted on a head commit", scoped: true, type: "json",
      read: (root) => readPolaris(root).settings.botReviewers,
      validate: (raw) => (Array.isArray(raw) && raw.length <= 20 && raw.every((b) => typeof b === "string" && b.length > 0 && b.length <= 100)
        ? { value: raw } : { error: "botReviewers: up to 20 bot logins" }),
      apply: (v, root) => saved(writePolaris(root, { ...(readStoredPolaris(root) ?? {}), botReviewers: v as string[] })),
      isSet: (root) => Array.isArray(readStoredPolaris(root)?.botReviewers),
    },
    ...DOOR_IDS.map((d): ServerSettingDef => ({
      id: `polaris.door.${d}`, page: "orchestration", label: `Polaris door ${d}: its mode and settings`, scoped: true, type: "json",
      read: (root) => readPolaris(root).settings.doors[d],
      // A mode alone keeps the settings the door already has.
      validate: (raw, root) => checkDoor(d, raw, readPolaris(root).settings.doors[d]),
      apply: (v, root) => saved(writePolaris(root, withDoor(readStoredPolaris(root), d, v as DoorValue))),
      isSet: (root) => !!readStoredPolaris(root)?.doors && d in readStoredPolaris(root)!.doors!,
      layer: (root) => readPolaris(root).layers[d],
    })),
    {
      id: "cleanup.mode", page: "orchestration", label: "After a pull request ends: off, ask, at merge or automatic cleanup of its local leftovers", scoped: true, type: "string",
      read: (root) => (root ? getSetting(root, "cleanup.mode") : "ask"),
      validate: (raw) => ((CLEANUP_MODES as readonly unknown[]).includes(raw) ? { value: raw } : { error: `one of ${CLEANUP_MODES.join(", ")}` }),
      apply: (v, root) => put(root, "cleanup.mode", v),
      isSet: (root) => hasSetting(root, "cleanup.mode"),
    },
    {
      id: "cleanup.orphanAutoRemove", page: "orchestration", label: "Docker leftovers: remove the orphan images and volumes the sweep lists by itself, when Docker > Disk loads", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "cleanup.orphanAutoRemove") : false),
      validate: bool,
      apply: (v, root) => put(root, "cleanup.orphanAutoRemove", v),
      isSet: (root) => hasSetting(root, "cleanup.orphanAutoRemove"),
    },
    {
      id: "cleanup.autoCleanDays", page: "orchestration", label: "Days after a merge when its leftovers are cleaned by themselves (0 = never)", scoped: true, type: "number",
      read: (root) => (root ? getSetting(root, "cleanup.autoCleanDays") : 0),
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 365 ? { value: raw } : { error: "a whole number of days, 0 to 365 (0 = never)" }),
      apply: (v, root) => put(root, "cleanup.autoCleanDays", v),
      isSet: (root) => hasSetting(root, "cleanup.autoCleanDays"),
    },
    {
      id: "cleanup.include", page: "orchestration", label: "Which leftovers a cleanup plan holds", scoped: true, type: "json",
      read: (root) => (root ? getSetting(root, "cleanup.include") : EMPTY_CLEANUP_CONFIG.include),
      validate: (raw) => parseCleanupInclude(raw),
      apply: (v, root) => put(root, "cleanup.include", v as string[]),
      isSet: (root) => hasSetting(root, "cleanup.include"),
    },
    {
      id: "cleanup.evidenceRoots", page: "orchestration", label: "Folders that hold a pull request's evidence (a folder whose name starts with the card id or the branch)", scoped: true, type: "json",
      read: (root) => (root ? getSetting(root, "cleanup.evidenceRoots") : EMPTY_CLEANUP_CONFIG.evidenceRoots),
      validate: (raw) => parseCleanupEvidenceRoots(raw),
      apply: (v, root) => put(root, "cleanup.evidenceRoots", v as string[]),
      isSet: (root) => hasSetting(root, "cleanup.evidenceRoots"),
    },
    {
      id: "cleanup.otherFolders", page: "orchestration", label: "Other folders that belong to a pull request's card without starting with its id (patterns with {card} and {number})", scoped: true, type: "json",
      read: (root) => (root ? getSetting(root, "cleanup.otherFolders") : EMPTY_CLEANUP_CONFIG.otherFolders),
      validate: (raw) => parseCleanupOtherFolders(raw),
      apply: (v, root) => put(root, "cleanup.otherFolders", v as string[]),
      isSet: (root) => hasSetting(root, "cleanup.otherFolders"),
    },
    {
      id: "cleanup.moveCard", page: "orchestration", label: "After a merge, move the card too (through the move door, jira.writes.move)", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "cleanup.moveCard") === true : false),
      validate: bool, apply: (v, root) => put(root, "cleanup.moveCard", v),
      isSet: (root) => hasSetting(root, "cleanup.moveCard"),
    },
    {
      id: "cleanup.moveCardStatus", page: "orchestration", label: "The status a merge's cleanup moves the card to, as the tracker names it", scoped: true, type: "string",
      read: (root) => (root ? String(getSetting(root, "cleanup.moveCardStatus") ?? "") : ""),
      validate: (raw) => (typeof raw === "string" && raw.length <= 120 ? { value: raw } : { error: "a status name, 120 characters or fewer" }),
      apply: (v, root) => put(root, "cleanup.moveCardStatus", v),
      isSet: (root) => hasSetting(root, "cleanup.moveCardStatus") && getSetting(root, "cleanup.moveCardStatus") !== "",
    },
    {
      id: "flow.delegationGuard", page: "orchestration", label: "The flow owns its jobs: the orchestrator may not spawn a Claude subagent for work a worker block takes", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "flow.delegationGuard"),
      validate: bool, apply: (v, root) => put(root ?? APP, "flow.delegationGuard", v),
      isSet: (root) => hasSetting(root ?? APP, "flow.delegationGuard"),
    },
    {
      id: "seat.model", page: "orchestration", label: "The chair's model", scoped: true, type: "string",
      read: (root) => seat(root)?.model ?? "",
      validate: (raw) => (typeof raw === "string" && raw.length <= 120 && !/[\s\0]/.test(raw) ? { value: raw } : { error: "a model name, one word" }),
      apply: (v, root) => { const r = seat(root); Seat.setSeatSettings(root!, String(v), r?.powers ?? "speak"); return { ok: true }; },
    },
    {
      id: "seat.powers", page: "orchestration", label: "What the chair may do to other agents", scoped: true, type: "string",
      read: (root) => seat(root)?.powers ?? "speak",
      validate: (raw) => (Seat.isPower(raw) ? { value: raw } : { error: "speak, nudge or assign" }),
      apply: (v, root) => { const r = seat(root); Seat.setSeatSettings(root!, r?.model ?? "", v as Seat.Power); return { ok: true }; },
    },
    {
      id: "seat.kind", page: "orchestration", label: "The chair's engine (its model goes back to that engine's default)", scoped: true, type: "string",
      read: (root) => seat(root)?.kind || "claude",
      validate: (raw) => {
        if (typeof raw !== "string" || !raw) return { error: "an engine id" };
        const no = Seat.chairRefusal(raw);
        return no ? { error: no } : { value: raw };
      },
      /* A model is one engine's: moving the chair to another engine leaves the
         choice to that engine's default, as the Settings save does. */
      apply: (v, root) => { const r = seat(root); Seat.setSeatSettings(root!, "", r?.powers ?? "speak", String(v)); return { ok: true }; },
    },
    {
      id: "seat.change", page: "orchestration", label: "Seat the chair again on its stored engine", scoped: true, type: "boolean",
      read: () => false,
      validate: (raw) => (raw === true ? { value: true } : { error: "true, to change the chair now" }),
      apply: async (_v, root) => {
        if (!env.terminalEnabled) return { ok: false, error: "the terminal is disabled here" };
        const r = await Seat.changeChair(root!, { wakeHours: seatWakeHours() });
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? "the chair did not change" };
      },
    },
    {
      id: "seat.wakeHours", page: "orchestration", label: "Hours between the chair's quiet wakes", type: "number",
      read: () => seatWakeHours(),
      validate: minutes(1, 24),
      apply: (v) => saved(writeSeatSettings({ seatWakeHours: Number(v) })),
    },
    {
      id: "hooks.gate", page: "hooks", label: "The gate (holds a tool call until a person decides)", type: "boolean",
      read: () => hookStatus().gate,
      validate: bool,
      apply: (v) => { if (!hookStatus().gateBundled) return { ok: false, error: "this build ships no gate" }; const r = applyGate(v ? "install" : "uninstall"); return r.ok ? { ok: true } : { ok: false, error: (r as { error?: string }).error ?? "the gate did not change" }; },
    },
    {
      id: "gate.answerer", page: "hooks", label: "Who is told when the gate holds an action (me, or me and the orchestrator)", type: "string",
      read: () => gateAnswerer(),
      validate: (raw) => (isOneOf(GATE_ANSWERERS, raw) ? { value: raw } : { error: "me or orchestrator" }),
      apply: (v) => saved(writeAgentDefaults({ gateAnswerer: v })),
    },
    {
      id: "gate.onTimeout", page: "hooks", label: "What a held action does when nobody answers (drop, or ask again first)", type: "string",
      read: () => gateOnTimeout(),
      validate: (raw) => (isOneOf(GATE_ON_TIMEOUT, raw) ? { value: raw } : { error: "drop or ask" }),
      apply: (v) => saved(writeAgentDefaults({ gateOnTimeout: v })),
    },
    {
      id: "plugins.master", page: "plugins", label: "Plugins (the master switch)", type: "boolean",
      read: () => masterEnabled(), validate: bool,
      apply: (v) => done(() => setMaster(v === true)),
    },
    ...listPlugins().flatMap((p): ServerSettingDef[] => [
      {
        id: `plugin.${p.name}.enabled`, page: "plugins", label: `Plugin ${p.name}`, type: "boolean",
        read: () => !!listPlugins().find((q) => q.name === p.name)?.enabled, validate: bool,
        /* Switching on approves what the plugin declares, so the card shows it, from
           the installed manifest's own record: the person approves that, and the door
           re-reads it on approval (a declaration that changed since applies nothing). */
        explain: (v) => (v ? declaration(p.name) : []),
        apply: async (v) => (v ? enablePlugin(p.name, true) : (await disablePlugin(p.name)) ? { ok: true } : { ok: false, error: "no such plugin" }),
      },
      {
        id: `plugin.${p.name}.unboxed`, page: "plugins", label: `Plugin ${p.name} may run outside its box`, type: "boolean",
        read: () => !!listPlugins().find((q) => q.name === p.name)?.allowUnboxed, validate: bool,
        apply: (v) => setPluginUnboxedConsent(p.name, v === true),
      },
    ]),
    {
      id: "budgets", page: "budgets", label: "Spending limits", type: "json",
      read: () => readBudgets(),
      validate: (raw) => { const c = cleanBudgets(raw); return typeof c === "string" ? { error: c } : { value: c }; },
      apply: (v) => (env.budgetWrites ? saved(writeBudgets(v as Budget[])) : { ok: false, error: "budget writes are disabled (AGENTGLASS_BUDGET_WRITE_DISABLED=1)" }),
    },
    { id: "lantern.nudge", page: "lantern", label: "Nudge idle agents", type: "boolean", read: () => lanternNudge(), validate: bool, apply: (v) => saved(writeLanternSettings({ lanternNudge: v === true })) },
    { id: "lantern.nudgeMinutes", page: "lantern", label: "Minutes before an idle agent is nudged", type: "number", read: () => lanternNudgeMinutes(), validate: minutes(LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN), apply: (v) => saved(writeLanternSettings({ lanternNudgeMinutes: Number(v) })) },
    { id: "lantern.watch", page: "lantern", label: "Wake the orchestrator", type: "boolean", read: () => lanternWatch(), validate: bool, apply: (v) => saved(writeLanternSettings({ lanternWatch: v === true })) },
    { id: "lantern.watchMinutes", page: "lantern", label: "Minutes between the orchestrator's wakes", type: "number", read: () => lanternWatchMinutes(), validate: minutes(LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN), apply: (v) => saved(writeLanternSettings({ lanternWatchMinutes: Number(v) })) },
    { id: "lantern.cacheTtlMinutes", page: "lantern", label: "Prompt cache window, minutes", type: "number", read: () => cacheTtlMinutes(), validate: minutes(1, 120), apply: (v) => saved(writeLanternSettings({ cacheTtlMinutes: Number(v) })) },
    { id: "jira.writes", page: "jira", label: "Let agentglass write to Jira (always on while AGENTGLASS_JIRA_WRITE=1)", type: "boolean", read: () => jiraWriteEnabled(), validate: bool, apply: (v) => done(() => setJiraWrites(v === true)) },
    jiraKindSetting({ id: "jira.writes.move", kind: "move", label: "Move cards between steps" }),
    jiraKindSetting({ id: "jira.writes.comment", kind: "comment", label: "Comment on a card" }),
    jiraKindSetting({ id: "jira.writes.link", kind: "link", label: "Link a pull request to its card" }),
    jiraKindSetting({ id: "jira.writes.assign", kind: "assign", label: "Assign a person" }),
    {
      id: "privacy.retentionDays", page: "privacy", label: "How long history is kept", type: "number",
      read: () => RETENTION_DAYS,
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3650 ? { value: raw } : { error: "a whole number of days, 0 to 3650 (0 keeps everything)" }),
      apply: (v) => saved(setRetentionDays(Number(v))),
    },
    {
      id: "privacy.clickupCardDays", page: "privacy", label: "How long a ClickUp card stays in the local index after it was last seen", type: "number",
      read: () => CLICKUP_CARD_DAYS,
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3650 ? { value: raw } : { error: "a whole number of days, 0 to 3650 (0 keeps everything)" }),
      apply: (v) => saved(setClickupCardDays(Number(v))),
    },
    {
      id: "privacy.ledgerStubDays", page: "privacy", label: "How long the understudy ledger keeps a bare write record", type: "number",
      read: () => UNDERSTUDY_STUB_DAYS,
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3650 ? { value: raw } : { error: "a whole number of days, 0 to 3650 (0 keeps everything)" }),
      apply: (v) => saved(setLedgerStubDays(Number(v))),
    },
    { id: "clickup.writes", page: "clickup", label: "Let agentglass write to ClickUp (always on while AGENTGLASS_CLICKUP_WRITE=1)", type: "boolean", read: () => clickupWriteEnabled(), validate: bool, apply: (v) => done(() => setWritesAllowed(v === true)) },
    {
      id: "clickup.includeSubtasks", page: "clickup", label: "Subtasks on Assigned to me", type: "boolean",
      read: () => clickupPrefs().assigned.includeSubtasks, validate: bool,
      apply: (v) => { const r = setClickupPrefs({ assigned: { includeSubtasks: v === true } }); return r.ok ? { ok: true } : { ok: false, error: r.error }; },
    },
    /* A repository's tracker and its ClickUp-writes switch, kept per repository:
       `--root` names the project whose checkout carries it (trackerProjects.ts). */
    {
      id: "tracker.choice", page: "tasks", label: "Which tracker a project's repository keeps its cards in (auto, ClickUp or Jira)", scoped: true, type: "string",
      read: (root) => trackerChoiceFor(repoOfRoot(root)),
      validate: (raw, root) => {
        if (!repoOfRoot(root)) return { error: NOT_A_CHECKOUT };
        return typeof raw === "string" && (TRACKER_CHOICES as readonly string[]).includes(raw) ? { value: raw } : { error: "auto, clickup or jira" };
      },
      apply: (v, root) => saved(setTrackerChoice(repoOfRoot(root), v)),
      isSet: (root) => trackerChoiceFor(repoOfRoot(root)) !== "auto",
    },
    {
      id: "tracker.clickupWrites", page: "tasks", label: "ClickUp changes on a project's repository (off: its ClickUp cards are read-only)", scoped: true, type: "boolean",
      read: (root) => { const repo = repoOfRoot(root); return !!repo && clickupWritesByRepo()[repo.toLowerCase()] === true; },
      validate: (raw, root) => (repoOfRoot(root) ? bool(raw) : { error: NOT_A_CHECKOUT }),
      apply: (v, root) => saved(setClickupWrites(repoOfRoot(root), v === true)),
      isSet: (root) => { const repo = repoOfRoot(root); return !!repo && clickupWritesByRepo()[repo.toLowerCase()] === true; },
    },
    {
      id: "secrets.keyring", page: "privacy", label: "Keep secrets in the system keyring", type: "boolean",
      read: () => keyringEnabled(), validate: bool,
      /* Moves every stored token between the files and the keyring, so it runs only
         once the person has approved (settingClass: escalation). Never a value in the answer. */
      apply: async (v) => { const r = await setKeyringEnabled(v === true); return r.ok ? { ok: true } : { ok: false, error: r.error }; },
    },
    {
      id: "phone.alerts", page: "notifications", label: "Alerts on paired phones", type: "boolean",
      read: () => phoneAlerts(), validate: bool,
      apply: (v) => saved(writePhoneAlerts(v === true)),
    },
    {
      id: "browser.workers", page: "browser", label: "Who may drive the built-in browser (engines and worker roles)", type: "json",
      read: () => browserWorkersNow(), validate: (raw) => validateBrowserWorkers(raw),
      apply: (v) => saveBrowserWorkers(v as BrowserWorkers),
    },
    {
      id: "browser.origins.allow", page: "browser", label: "Origins a worker's browser may be pointed at (host or host:port; * is every origin; AGENTGLASS_BROWSER_ORIGINS wins when set)", type: "json",
      read: () => storedAllowList("origins"), validate: (raw) => cleanAllowList(raw, "origins"),
      apply: (v) => saved(writeBrowserLimit("origins", v as string[])),
    },
    {
      id: "browser.profiles.allow", page: "browser", label: "Named profiles a worker's browser may use (* is every profile; AGENTGLASS_BROWSER_PROFILES wins when set)", type: "json",
      read: () => storedAllowList("profiles"), validate: (raw) => cleanAllowList(raw, "profiles"),
      apply: (v) => saved(writeBrowserLimit("profiles", v as string[])),
    },
    {
      id: "browser.workerVerbs", page: "browser", label: "Which groups of browser verbs a worker may run (read, act, devtools, cookies-storage, eval)", type: "json",
      read: () => workerVerbGroups(), validate: (raw) => cleanVerbGroups(raw),
      apply: (v) => saved(writeBrowserLimit("verbs", v as string[])),
    },
    {
      id: "workers.gitInternals", page: "orchestration", label: "A worker's shell may write the directory core.hooksPath names and submodule git dirs", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "workers.gitInternals") === true, validate: bool,
      apply: (v, root) => put(root ?? APP, "workers.gitInternals", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.gitInternals"),
    },
    {
      id: "workers.unwalledEngines", page: "orchestration", label: "Run engines with no read wall (Hermes) as workers", scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, "workers.unwalledEngines") === true, validate: bool,
      apply: (v, root) => put(root ?? APP, "workers.unwalledEngines", v),
      isSet: (root) => hasSetting(root ?? APP, "workers.unwalledEngines"),
    },
    /* One per app door a worker's shell is denied (`WORKER_DENIED`, the browser aside, which
       browser.workers drives). Opening one only lifts the shell's deny rule: the CLI runs under
       the worker's own, whole-machine-scoped credential, the same one every other door checks —
       so this switch does not hand it a credential of its own, only a wider shell. */
    ...APP_DOORS.map((door): ServerSettingDef => ({
      id: `workers.appDoors.${door}`, page: "orchestration", label: `A worker's shell may run ${door} — its own routes, still under the worker's shared credential`, scoped: true, type: "boolean",
      read: (root) => getSetting(root ?? APP, `workers.appDoors.${door}` as SettingKey) === true,
      validate: bool, apply: (v, root) => put(root ?? APP, `workers.appDoors.${door}` as SettingKey, v),
      isSet: (root) => hasSetting(root ?? APP, `workers.appDoors.${door}` as SettingKey),
    })),
    /* The commands a project may close to every worker's shell: open by default (a worker does what its seat does).
       Closing is narrowing, so anyone may; opening again is only the person's (the class row). */
    ...SWITCHABLE_COMMANDS.map((cmd): ServerSettingDef => {
      const key = `workers.commands.${cmd.replace(/ /g, "-")}` as SettingKey;
      return {
        id: `workers.commands.${cmd.replace(/ /g, "-")}`, page: "orchestration", label: `A worker's shell may run ${cmd}`, scoped: true, type: "boolean",
        read: (root) => getSetting(root ?? APP, key) !== false,
        validate: bool, apply: (v, root) => put(root ?? APP, key, v),
        isSet: (root) => hasSetting(root ?? APP, key),
        pin: true,
      };
    }),
    /* A limit the environment used to hold alone (shared/envLimits.ts). The row edits the stored value; a
       variable that is set wins, and the door says so (`envLimitHeldBy`) so the page locks the row. */
    ...ENV_LIMITS.map((l): ServerSettingDef => ({
      id: l.id, page: "orchestration", label: `${l.label} (${l.env})`, type: l.kind === "switch" ? "boolean" : l.kind === "number" ? "number" : "string",
      read: () => envLimitValue(l),
      validate: (raw) => validateEnvLimit(l, raw),
      apply: (v) => {
        const held = envLimitHeldBy(l.env);
        if (held) return { ok: false, error: `${held.name} is set in the environment and holds this limit: unset it to change it here` };
        return saved(writeEnvLimit(l.env, l.kind === "switch" ? (v === true ? "1" : "0") : String(v)));
      },
    })),
    {
      /* The stored value, not the effective one: "" is automatic. The environment's
         AGENTGLASS_SCOPE_MEMORY_MAX wins over it, and the page says so (`memoryMaxEnv`). */
      id: "workers.memoryMax", page: "orchestration", label: "Memory one worker may hold (AGENTGLASS_SCOPE_MEMORY_MAX), like 20G; empty is automatic", type: "string",
      read: () => scopeConfig().memoryMax ?? "",
      validate: (raw) => {
        if (raw === "" || raw === null) return { value: "" };
        const v = validSize(raw);
        return v ? { value: v } : { error: "a size like 20G, 512M or 2T, or empty for automatic" };
      },
      apply: (v) => saved(writeScopeMemoryMax(v as string)),
    },
    {
      id: "flow.agentEdit", page: "orchestration", label: "Let this project's orchestrator edit its own flow and roster", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.agentEdit") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.agentEdit", v),
      isSet: (root) => hasSetting(root, "flow.agentEdit"),
    },
    {
      id: "flow.sessionStart.move", page: "orchestration", label: "The flow's Session start step moves the card to a status (through the move door, jira.writes.move)", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.sessionStart.move") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.sessionStart.move", v),
      isSet: (root) => hasSetting(root, "flow.sessionStart.move"),
    },
    {
      id: "flow.autoContinue", page: "orchestration", label: "A worker's end, with no trailing question, starts the next flow role in the same tab", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.autoContinue") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.autoContinue", v),
      isSet: (root) => hasSetting(root, "flow.autoContinue"),
    },
    {
      id: "flow.enforce", page: "orchestration", label: "Hold workers to the flow", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.enforce") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.enforce", v),
      isSet: (root) => hasSetting(root, "flow.enforce"),
    },
    {
      id: "flow.notifyPrReviews", page: "orchestration", label: "Tell the seat about a bot review on an open pull request", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.notifyPrReviews") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.notifyPrReviews", v),
      isSet: (root) => hasSetting(root, "flow.notifyPrReviews"),
    },
    {
      id: "flow.notifyPrReviews.bots", page: "orchestration", label: "Extra logins that count as a bot's review, one per line", scoped: true, type: "string",
      read: (root) => (root ? String(getSetting(root, "flow.notifyPrReviews.bots") ?? "") : ""),
      validate: (v) => (typeof v === "string" && v.length <= 2000 ? { value: v } : { error: "a list of logins, 2000 characters or fewer" }),
      apply: (v, root) => put(root, "flow.notifyPrReviews.bots", v),
      isSet: (root) => hasSetting(root, "flow.notifyPrReviews.bots"),
    },
    {
      id: "flow.nextCard.enabled", page: "orchestration", label: "Start a scout for every unclaimed card a saved filter shows", scoped: true, type: "boolean",
      read: (root) => (root ? getSetting(root, "flow.nextCard.enabled") === true : false),
      validate: bool, apply: (v, root) => put(root, "flow.nextCard.enabled", v),
      isSet: (root) => hasSetting(root, "flow.nextCard.enabled"),
    },
    {
      id: "flow.nextCard.filterId", page: "orchestration", label: "The saved Jira filter to read, by its id", scoped: true, type: "string",
      read: (root) => (root ? String(getSetting(root, "flow.nextCard.filterId") ?? "") : ""),
      validate: (v) => (typeof v === "string" && /^\d{0,12}$/.test(v) ? { value: v } : { error: "a Jira filter id (digits only), or empty" }),
      apply: (v, root) => put(root, "flow.nextCard.filterId", v),
      isSet: (root) => hasSetting(root, "flow.nextCard.filterId"),
    },
    {
      id: "flow.nextCard.cap", page: "orchestration", label: "The most scouts this runs at once for the filter", scoped: true, type: "number",
      read: (root) => (root ? getSetting(root, "flow.nextCard.cap") : 2),
      validate: (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 10 ? { value: raw } : { error: "a whole number from 1 to 10" }),
      apply: (v, root) => put(root, "flow.nextCard.cap", v),
      isSet: (root) => hasSetting(root, "flow.nextCard.cap"),
    },
    {
      id: "flow.sessionStart.moveStatus", page: "orchestration", label: "The status Session start moves the card to, as the tracker names it", scoped: true, type: "string",
      read: (root) => (root ? String(getSetting(root, "flow.sessionStart.moveStatus") ?? "") : ""),
      validate: (raw) => (typeof raw === "string" && raw.length <= 120 ? { value: raw } : { error: "a status name, 120 characters or fewer" }),
      apply: (v, root) => put(root, "flow.sessionStart.moveStatus", v),
      isSet: (root) => hasSetting(root, "flow.sessionStart.moveStatus") && getSetting(root, "flow.sessionStart.moveStatus") !== "",
    },
    /* Held per project (agentTrust.ts): a root names the project the page is
       editing, and no root is the global value that a request naming no project
       reads. Not `scoped`, which would refuse the global write. */
    {
      id: "agents.changeWithoutAsking", page: "orchestration", label: "Let my agents change settings without asking", type: "boolean",
      read: (root) => agentsTrusted(root), validate: bool,
      apply: (v, root) => saved(writeAgentsTrusted(v === true, root)),
      isSet: (root) => agentsTrustSetAt(root),
    },
  ];
  return defs;
}
