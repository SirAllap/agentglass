import { useState, useSyncExternalStore } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave } from "../save/index.ts";
import { Switch } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { LINE, Segmented } from "../../workspace/Chrome.tsx";
import { BudgetsPane } from "../../BudgetsPane.tsx";
import { UsageAccountsCard } from "../../engines/UsageAccountsCard.tsx";
import { OpenCodeGoCard } from "../../engines/UsageKeyCard.tsx";
import { GhBudget } from "./GhAllowance.tsx";
import { useOffered } from "../../orchestration/flow/ModelInput.tsx";
import { api } from "../../../lib/api.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { everSeen } from "../../../lib/usageBarPref.ts";
import { setUsageRefreshOn } from "../../../lib/usageRefreshPref.ts";
import { paceConfig, setPaceConfig, subscribePaceConfig } from "../../../lib/paceConfig.ts";
import type { PaceConfig } from "../../../../../shared/pace.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { registerRead, useSettingsData } from "../shell/pageLoad.tsx";
import type { PageCtx } from "./ctx.ts";
import { HIT } from "../../../lib/iconSize.ts";

/* Engines & usage: which CLI and model each worker role starts with, then what
   the plan allows and how fast it is being spent. Same ids and stores as the
   old Engines and Usage & budgets pages. Applies to is left as the later
   shared ScopeControl will place it. */

const ROLES = ["scout", "builder", "reviewer", "verifier"] as const;
type Choice = { provider: string; model: string };
type Provider = { id: string; title: string; installed: boolean };
const ROLE_HELP: Record<string, string> = {
  scout: "Reads the code and reports back before anyone builds.",
  builder: "Writes the change and runs its tests.",
  reviewer: "Reads the diff and lists what is wrong.",
  verifier: "Runs the checks and says if the change holds.",
};
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** One role: an engine Select and a model Select. A change saves at once; Undo puts the pair back. */
function RoleRow({ role, value, providers, onSave }: { role: string; value: Choice; providers: Provider[]; onSave: (c: Choice) => void }) {
  const offered = useOffered(value.provider);
  const models = value.model && !offered.includes(value.model) ? [...offered, value.model] : offered;
  const label = `${cap(role)} role`;
  const save = (next: Choice) => instantSave(value, next, onSave);
  return (
    <SettingRow kind="control" settingId={`agents.role.${role}`} label={label} help={ROLE_HELP[role] ?? "Picks the engine and model this role starts with."}
      control={<div className="flex items-center gap-2">
        <Select value={value.provider} align="right" options={providers.map((p) => ({ value: p.id, label: p.installed ? p.title : `${p.title} (not installed)` }))}
          onChange={(v) => save({ provider: v, model: "" })} />
        <Select value={value.model} align="right" options={[{ value: "", label: "Its default model" }, ...models.map((m) => ({ value: m, label: m }))]}
          onChange={(v) => save({ provider: value.provider, model: v })} />
      </div>} />
  );
}

/* Through the Settings cache: the page opens with the last roles and the nav warms them on hover. */
type RolesRead = Awaited<ReturnType<typeof api.workerRoles>>;
const ROLES_READ = "engines/roles";
registerRead("engines", ROLES_READ, () => api.workerRoles());

function RoleEngines() {
  const { data: read, failed, reload, set } = useSettingsData<RolesRead>(ROLES_READ);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const roles = read?.ok ? read.roles : null;
  const providers: Provider[] = (read?.ok ? read.providers : undefined) ?? [];
  const err = saveErr ?? (failed ? "Could not reach the server." : read && !read.ok ? read.error ?? "Could not read the roles." : null);
  const save = async (role: string, c: Choice) => {
    const r = await api.workerRoleSave(role, c.provider, c.model).catch(() => null);
    if (!r?.ok) { setSaveErr(r?.error ?? "That did not save."); void reload(); return; }
    setSaveErr(null); set({ ...read!, ok: true, roles: r.roles, providers: r.providers ?? providers });
  };
  if (!roles) return <div role={err ? "alert" : "status"} className="px-3 py-2 text-[12px]" style={{ color: err ? "var(--error-ink)" : "var(--text2)" }}>{err ?? "Reading the roles…"}</div>;
  return (
    <>
      {ROLES.filter((r) => roles[r]).map((r) => <RoleRow key={r} role={r} value={roles[r]!} providers={providers} onSave={(c) => void save(r, c)} />)}
      {err && <div role="alert" className="px-3 pb-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
    </>
  );
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) => ({ value: String(h), label: h >= 24 ? "24:00" : `${String(h).padStart(2, "0")}:00` }));

/** A pace setting: write through the store, Undo writes the old values back. */
function usePace() {
  const cfg = useSyncExternalStore(subscribePaceConfig, paceConfig, paceConfig);
  const change = <K extends keyof PaceConfig>(key: K, next: PaceConfig[K]) => instantSave(cfg[key], next, (v) => setPaceConfig({ [key]: v } as Partial<PaceConfig>));
  return { cfg, change };
}

function PlanPace() {
  const { cfg, change } = usePace();
  const working = cfg.spread === "working";
  const noDays = working && !cfg.workDays.some(Boolean);
  const hint = (w: string) => (working ? w : "Off while every hour counts.");
  const row = (label: string, help: string, control: React.ReactNode) => working
    ? <SettingRow kind="control" label={label} help={help} control={control} />
    : <SettingRow kind="locked" label={label} help={help} reason="Needs Working hours" control={control} />;
  return (
    <>
      <SettingRow kind="control" label="Spread the week's budget over" help="Decides whether working hours or every hour earn budget."
        control={<Segmented track label="Spread the week's budget over" value={cfg.spread} onChange={(v) => change("spread", v as PaceConfig["spread"])}
          options={[{ id: "working", label: "Working hours" }, { id: "all", label: "Every hour" }]} />} />
      {row("Working days", noDays ? "None ticked, so every hour counts." : "Picks the days that earn budget.",
        <span className="flex gap-1" role="group" aria-label="Working days">
          {DAY_NAMES.map((d, i) => (
            <button key={d} type="button" aria-pressed={cfg.workDays[i]} aria-label={d} disabled={!working}
              onClick={() => change("workDays", cfg.workDays.map((x, j) => (j === i ? !x : x)))}
              className="text-[11px] rounded-md px-1.5" style={{ minWidth: 28, height: HIT, border: LINE, background: cfg.workDays[i] ? "var(--accent)" : "transparent", color: cfg.workDays[i] ? "var(--bg)" : "var(--text2)" }}>{d[0]}</button>
          ))}
        </span>)}
      {row("Work starts", hint("Sets the hour the day starts earning budget."), <Select value={String(cfg.workStart)} options={hours(0, cfg.workEnd - 1)} align="right" onChange={(v) => change("workStart", Number(v))} />)}
      {row("Work ends", hint("Sets the hour the day stops earning budget."), <Select value={String(cfg.workEnd)} options={hours(cfg.workStart + 1, 24)} align="right" onChange={(v) => change("workEnd", Number(v))} />)}
      <SettingRow kind="control" label="Roll unused share forward" help="Lets a quiet Monday leave more for Tuesday."
        control={<button type="button" role="switch" aria-checked={cfg.rollover} aria-label="Roll unused share forward" onClick={() => change("rollover", !cfg.rollover)} className="agx-switch-hit inline-flex items-center rounded-full"><Switch on={cfg.rollover} /></button>} />
      <SettingRow kind="control" label="Recent burn looks back" help="Sets how far back the runs-out guess measures your speed."
        control={<Select value={String(cfg.burnWindowHours)} align="right" options={[1, 3, 6].map((h) => ({ value: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))} onChange={(v) => change("burnWindowHours", Number(v))} />} />
      <SettingRow kind="control" label="Alert when a weekly window reaches" help="Sends one notification per window at this level."
        control={<Select value={String(cfg.alertAt)} align="right" options={[80, 90, 95].map((p) => ({ value: String(p), label: `${p} %` }))} onChange={(v) => change("alertAt", Number(v))} />} />
    </>
  );
}

/** One literal call per provider, so each stored key is named once in source. */
const BAR_SET: Record<"anthropic" | "codex" | "opencode" | "antigravity", (v: boolean) => void> = {
  anthropic: (v) => setting("usage.bar.anthropic").set(v),
  codex: (v) => setting("usage.bar.codex").set(v),
  opencode: (v) => setting("usage.bar.opencode").set(v),
  antigravity: (v) => setting("usage.bar.antigravity").set(v),
};

const BAR: { id: "anthropic" | "codex" | "opencode" | "antigravity"; label: string; help: string }[] = [
  { id: "anthropic", label: "Claude", help: "Shows Claude in the top bar." },
  { id: "codex", label: "Codex", help: "Shows Codex in the top bar." },
  { id: "opencode", label: "OpenCode Go", help: "Shows OpenCode Go in the top bar." },
  { id: "antigravity", label: "Antigravity", help: "Shows a dashed cell; it has no quota data." },
];

export function EnginesUsagePage({ c }: { c: PageCtx }) {
  const { barShown, setBarShown, usageRefresh, setUsageRefreshState, open } = c;
  return (
    <SettingsPage title="Engines & usage" purpose="Choose the engine each worker role uses, and watch what your plans allow."
      sections={[
        { id: "engines", title: "Engines", kind: "normal", body: (
          <Section id="engines" title="Engines" intro="A change applies to the next worker that starts.">
            <RoleEngines />
            <SettingRow kind="link" label="Extra flags per engine" help="Edits the launch flags each engine starts with." linkText="Open Advanced" onOpen={() => openSettings("advanced")} />
          </Section>) },
        { id: "providers", title: "Providers", kind: "normal", body: (
          <Section id="providers" title="Providers" intro="Keys and allowances agentglass reads to show your usage.">
            {everSeen("codex") && (
              <SettingRow kind="control" label="Check Codex usage in the background" help="Runs one small turn each hour, which spends a little quota."
                control={<button type="button" role="switch" aria-checked={usageRefresh} aria-label="Check Codex usage in the background" className="agx-switch-hit inline-flex items-center rounded-full"
                  onClick={() => instantSave(usageRefresh, !usageRefresh, (v) => { setUsageRefreshOn(v); setUsageRefreshState(v); })}><Switch on={usageRefresh} /></button>} />
            )}
            <OpenCodeGoCard />
            <GhBudget open={open} />
          </Section>) },
        { id: "accounts", title: "Accounts", kind: "normal", body: <Section id="accounts" title="Accounts" intro="More than one plan per provider. A rule that names only a provider means the default account."><UsageAccountsCard /></Section> },
        { id: "pace", title: "Plan pace", kind: "normal", body: <Section id="pace" title="Plan pace" intro="Spreads the week's budget over the days you work."><PlanPace /></Section> },
        { id: "spending", title: "Spending", kind: "normal", body: <Section id="spending" title="Spending" intro="A limit you choose, so spend alerts mean something."><BudgetsPane open={open} /></Section> },
        { id: "bar", title: "Usage bar", kind: "normal", body: (
          <Section id="bar" title="Usage bar" intro="Chooses which providers get a cell in the top bar.">
            {BAR.map((b) => (
              <SettingRow key={b.id} kind="control" settingId={`usage.bar.${b.id}`} label={b.label} help={b.help}
                control={<button type="button" role="switch" aria-checked={barShown[b.id]} aria-label={b.label} className="agx-switch-hit inline-flex items-center rounded-full"
                  onClick={() => instantSave(barShown[b.id], !barShown[b.id], (v) => { BAR_SET[b.id](v); setBarShown((s) => ({ ...s, [b.id]: v })); })}><Switch on={barShown[b.id]} /></button>} />
            ))}
          </Section>) },
      ]}
    />
  );
}
