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
import { validatePolicy } from "../../shared/orchestration.ts";
import { isLaunchMode, parseDenyRules, parseFlagLine } from "../../shared/launchModes.ts";
import { AGENT_PROVIDERS } from "../../shared/agentKinds.ts";
import { WORKER_ROLES } from "../../shared/workerRoles.ts";
import { GATE_ANSWERERS, GATE_ON_TIMEOUT, isOneOf } from "../../shared/agentDefaults.ts";
import {
  launchMode, launchDeny, writeLaunchPermissions, launchFlagOverrides, writeLaunchFlagOverrides, seatWakeHours, writeSeatSettings, workerRoles, writeWorkerRole,
  readBudgets, writeBudgets, policyRoots, lanternNudge, lanternNudgeMinutes, lanternWatch, lanternWatchMinutes, cacheTtlMinutes,
  gateAnswerer, gateOnTimeout, writeAgentDefaults,
  writeLanternSettings, LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN, agentsChangeWithoutAsking, writeAgentsChangeWithoutAsking, phoneAlerts, writePhoneAlerts,
} from "./config.ts";
import { readPolicy, writePolicy } from "./orchestration.ts";
import * as Seat from "./seat.ts";
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
      apply: (v) => saved(writeLaunchPermissions({ mode: v })),
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
      apply: (v) => saved(writeLaunchPermissions({ deny: v })),
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
