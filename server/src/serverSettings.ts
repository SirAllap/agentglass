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
import type { Budget } from "../../shared/types.ts";
import { writeLaunchBase } from "./agentRulesStore.ts";
import { validatePolicy } from "../../shared/orchestration.ts";
import { isLaunchMode, parseDenyRules, parseFlagLine } from "../../shared/launchModes.ts";
import { AGENT_PROVIDERS } from "../../shared/agentKinds.ts";
import { WORKER_ROLES } from "../../shared/workerRoles.ts";
import { GATE_ANSWERERS, GATE_ON_TIMEOUT, isOneOf } from "../../shared/agentDefaults.ts";
import {
  launchMode, launchDeny, launchFlagOverrides, writeLaunchFlagOverrides, seatWakeHours, writeSeatSettings, workerRoles, writeWorkerRole,
  readBudgets, writeBudgets, policyRoots, lanternNudge, lanternNudgeMinutes, lanternWatch, lanternWatchMinutes, cacheTtlMinutes,
  gateAnswerer, gateOnTimeout, writeAgentDefaults,
  writeLanternSettings, LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN, agentsChangeWithoutAsking, writeAgentsChangeWithoutAsking, phoneAlerts, writePhoneAlerts,
} from "./config.ts";
import { readPolicy, writePolicy } from "./orchestration.ts";
import { readPolaris, readStoredPolaris, writePolaris } from "./config.ts";
import { DOOR_IDS, checkDoor, withDoor, withEnabled, type DoorValue } from "../../shared/polaris.ts";
import { CLEANUP_MODES, EMPTY_CLEANUP_CONFIG, parseCleanupConfig, parseCleanupEvidenceRoots, parseCleanupInclude, parseCleanupOtherFolders, type CleanupConfig } from "./cleanup.ts";
import * as Seat from "./seat.ts";
import { ruleRoot } from "./agentRulesStore.ts";
import { APP, REVIEWS, getSetting, hasSetting, markHeld, putSetting, type SettingKey } from "./preflightStore.ts";
import { hookStatus, applyGate } from "./hooksetup.ts";
import { masterEnabled, setMaster, listPlugins, enablePlugin, disablePlugin, setPluginUnboxedConsent } from "./plugins.ts";
import { jiraWriteEnabled, jiraWriteKinds, setJiraWrites, setJiraWriteKind, type JiraWriteKind } from "./jira.ts";
import { clickupWriteEnabled } from "./clickup.ts";
import { RETENTION_DAYS, setRetentionDays } from "./retention.ts";
import { setWritesAllowed } from "./clickupviews.ts";
import { keyringEnabled } from "./keyring.ts";
import { setKeyringEnabled } from "./keyringSwitch.ts";
import { clickupPrefs, setClickupPrefs } from "./clickupPrefs.ts";
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
    return { ...EMPTY_CLEANUP_CONFIG, ...(c && "value" in c ? c.value : {}), ...("value" in inc ? { include: inc.value } : {}), ...("value" in roots ? { evidenceRoots: roots.value } : {}), ...("value" in other ? { otherFolders: other.value } : {}) };
  } catch { return EMPTY_CLEANUP_CONFIG; }
}
const capUsd = (raw: unknown): Check => (typeof raw === "number" && raw > 0 && raw <= 1000 ? { value: raw } : { error: "a number above 0 and up to 1000" });
const bool = (raw: unknown): Check => (typeof raw === "boolean" ? { value: raw } : { error: "true or false" });
const minutes = (lo: number, hi: number) => (raw: unknown): Check => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? { value: Math.min(hi, Math.max(lo, Math.round(n))) } : { error: `a number from ${lo} to ${hi}` };
};
/** A config write's answer as the door wants it. */
const saved = (r: { ok: boolean; error?: string }): Applied => (r.ok ? { ok: true } : { ok: false, error: r.error ?? "could not save it" });
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
}

/** One kind of Jira write, as its own switch under the master one (server/src/jira.ts, writeRefusal). */
const jiraKindSetting = (d: { id: string; kind: JiraWriteKind; label: string }): ServerSettingDef =>
  ({ id: d.id, page: "jira", label: d.label, type: "boolean", read: () => jiraWriteKinds()[d.kind], validate: bool, apply: (v) => done(() => setJiraWriteKind(d.kind, v === true)) });

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
      id: "flightPlan.preflight.sizes", page: "orchestration", label: "Which plan sizes get a Preflight (L, or ML for M and L)", type: "string",
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
      id: "flightPlan.preflight.model", page: "orchestration", label: "The model a Preflight reviews with", scoped: true, type: "string",
      read: (root) => (root ? getSetting(root, "flightPlan.preflight.model") : "sonnet"),
      validate: (raw) => (typeof raw === "string" && raw.length <= 120 && /^[A-Za-z0-9][\w.\[\]-]*$/.test(raw) ? { value: raw } : { error: "a model name, one word" }),
      apply: (v, root) => put(root, "flightPlan.preflight.model", v),
    },
    {
      id: "flightPlan.preflight.costCapUsd", page: "orchestration", label: "The most one Preflight may spend, in dollars (above 0, up to 5)", scoped: true, type: "number",
      read: (root) => (root ? getSetting(root, "flightPlan.preflight.costCapUsd") : 0.5),
      validate: (raw) => (typeof raw === "number" && raw > 0 && raw <= 5 ? { value: raw } : { error: "a number above 0 and up to 5" }),
      apply: (v, root) => put(root, "flightPlan.preflight.costCapUsd", v),
    },
    {
      id: "cleanup.config", page: "orchestration", label: "What cleaning up after a merged pull request may remove", scoped: true, type: "json",
      read: (root) => { const { include: _kinds, evidenceRoots: _roots, otherFolders: _other, ...body } = root ? cleanupConfigOf(root) : EMPTY_CLEANUP_CONFIG; return body; },
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
    { id: "jira.writes", page: "jira", label: "Let agentglass write to Jira", type: "boolean", read: () => jiraWriteEnabled(), validate: bool, apply: (v) => done(() => setJiraWrites(v === true)) },
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
    { id: "clickup.writes", page: "clickup", label: "Let agentglass write to ClickUp", type: "boolean", read: () => clickupWriteEnabled(), validate: bool, apply: (v) => done(() => setWritesAllowed(v === true)) },
    {
      id: "clickup.includeSubtasks", page: "clickup", label: "Subtasks on Assigned to me", type: "boolean",
      read: () => clickupPrefs().assigned.includeSubtasks, validate: bool,
      apply: (v) => { const r = setClickupPrefs({ assigned: { includeSubtasks: v === true } }); return r.ok ? { ok: true } : { ok: false, error: r.error }; },
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
      id: "agents.changeWithoutAsking", page: "orchestration", label: "Let my agents change settings without asking", type: "boolean",
      read: () => agentsChangeWithoutAsking(), validate: bool,
      apply: (v) => saved(writeAgentsChangeWithoutAsking(v === true)),
    },
  ];
  return defs;
}
