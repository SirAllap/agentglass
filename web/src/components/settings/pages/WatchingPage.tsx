import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave, DangerAction } from "../save/index.ts";
import { Switch } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { Button, EDGE, LINE } from "../../workspace/Chrome.tsx";
import { StatusBadge } from "../../SettingsKit.tsx";
import { api } from "../../../lib/api.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import type { HookSetupStatus } from "../../../../../shared/types.ts";
import { AgentCard } from "../../LanternView.tsx";
import { subscribeLantern, lanternRows, lanternCacheTtlMs, refreshLantern } from "../../../lib/lanternStore.ts";
import { useReportHead } from "../../SettingsPageState.tsx";
import { liveSessions, stateOf, sessionLabel, idleSessions, previewRows, needCount, type SessionState } from "../../../lib/watchingSessions.ts";
import type { PageCtx } from "./ctx.ts";

/* Watching: the board that looks at every session, the check-in question, and
   the Claude Code hooks that feed them. Ids and stores are the old Hooks page's. */

type Lantern = { nudge: boolean; minutes: number; watch: boolean; watchMinutes: number; cacheTtlMinutes: number };
type Patch = { nudge?: boolean; minutes?: number; watch?: boolean; watchMinutes?: number; cacheTtlMinutes?: number };
const WATCH_STEPS = [5, 10, 15, 30, 60];
const ASK_STEPS = [10, 20, 45, 90];
const near = (steps: number[], v: number) => steps.find((m) => m >= v) ?? steps[steps.length - 1]!;
const mins = (steps: number[]) => steps.map((m) => ({ value: String(m), label: `${m} min` }));

function useLantern(open: boolean) {
  const [s, setS] = useState<Lantern | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.lanternSettings().then((r) => { if (r.ok) { setS(r); setErr(null); } else setErr("The saved value could not be read."); }).catch(() => setErr("The saved value could not be read."));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  const write = async (f: Patch) => {
    const r = await api.lanternSettingsSave(f).catch(() => null);
    if (!r?.ok) { setErr(r?.error ?? "Could not save."); load(); return; }
    setErr(null);
    setS((cur) => (cur ? { nudge: r.nudge ?? cur.nudge, minutes: r.minutes ?? cur.minutes, watch: r.watch ?? cur.watch, watchMinutes: r.watchMinutes ?? cur.watchMinutes, cacheTtlMinutes: r.cacheTtlMinutes ?? cur.cacheTtlMinutes } : cur));
  };
  /** One instant change: the old value goes back through the same write on Undo. */
  const change = <K extends keyof Patch>(key: K, next: NonNullable<Patch[K]>) => {
    if (!s) return;
    const old = s[key] as NonNullable<Patch[K]>;
    instantSave(old, next, (v) => void write({ [key]: v } as Patch));
  };
  return { s, err, change };
}

function Sw({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled?: boolean; onFlip: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onFlip} className="agx-switch-hit inline-flex items-center rounded-full"><Switch on={on} /></button>;
}

function Problem({ text }: { text: string | null }) {
  return text ? <div role="alert" className="px-3 pb-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div> : null;
}

/** Locked while the thing it needs is off; never a hidden row. */
function Dep({ on, reason, label, help, control, settingId }: { on: boolean; reason: string; label: string; help: string; control: React.ReactNode; settingId?: string }) {
  return on ? <SettingRow kind="control" settingId={settingId} label={label} help={help} control={control} /> : <SettingRow kind="locked" settingId={settingId} label={label} help={help} reason={reason} control={control} />;
}

const STATE_DOT: Record<SessionState, string> = { working: "var(--success)", "needs you": "var(--warning)", idle: "var(--text4)" };
const STATE_INK: Record<SessionState, string> = { working: "var(--success-ink)", "needs you": "var(--warning-ink)", idle: "var(--text3)" };

/** One live session: the dot, the whole name (it wraps, never cut), the state. */
function SessionLine({ label, state }: { label: string; state: SessionState }) {
  return (
    <div data-session-row className="flex items-start gap-2.5 px-3 py-2.5 min-w-0" style={{ borderTop: LINE }}>
      <span aria-hidden className="shrink-0 rounded-full mt-1.5" style={{ width: 8, height: 8, background: STATE_DOT[state] }} />
      <span className="flex-1 min-w-0 text-[12.5px] font-semibold font-mono [overflow-wrap:anywhere]" style={{ color: "var(--text)" }}>{label}</span>
      <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-none" style={{ color: STATE_INK[state], background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>{state}</span>
    </div>
  );
}

export function WatchingPage({ c }: { c: PageCtx }) {
  const { s, err, change } = useLantern(c.open);
  const [hooks, setHooks] = useState<HookSetupStatus | null>(null);
  const [hookErr, setHookErr] = useState<string | null>(null);
  useEffect(() => { if (c.open) void api.hooksStatus().then(setHooks).catch(() => setHookErr("Could not reach the server.")); }, [c.open]);
  const wire = async (kind: "install" | "uninstall") => {
    const r = await (kind === "install" ? api.hooksInstall() : api.hooksUninstall()).catch(() => ({ ok: false, installed: false, changed: false, settingsPath: "", error: "Could not reach the server" }));
    if (!r.ok) { setHookErr(r.error || "Could not update the hooks"); return; }
    setHookErr(null); setHooks((h) => (h ? { ...h, installed: r.installed } : h));
  };
  const off = !s;
  const watch = s?.watch ?? false;
  const board = useSyncExternalStore((l) => subscribeLantern(l, c.open), lanternRows, lanternRows);
  const live = useMemo(() => liveSessions(board), [board]);
  const idle = useMemo(() => idleSessions(live), [live]);
  const need = needCount(live);
  // Chips replace the nav's own, so the hooks and gate ones are said here too.
  useReportHead("hooks", hooks ? {
    chips: [
      { tone: hooks.installed ? "ok" : "off", text: hooks.installed ? "Hooks wired" : "Hooks not wired" },
      ...(hooks.gateBundled ? [{ tone: hooks.gate ? "ok" as const : "warn" as const, text: hooks.gate ? "Gate on" : "Gate off" }] : []),
      { tone: live.length ? "ok" : "off", text: `Watching ${live.length}` },
      ...(need ? [{ tone: "warn" as const, text: `${need} need you` }] : []),
    ],
  } : null);
  /** The app's own stop for one session (ends the turn, closes the tab), once for each idle one. */
  const closeIdle = async () => {
    // Read the board again now: a session that went back to work since the last look is not stopped.
    await refreshLantern().catch(() => {});
    for (const r of idleSessions(liveSessions(lanternRows()))) void api.agentStop(r.name).catch(() => {});
  };
  const aside = (
    <div data-watching-preview className="rounded-lg p-3 flex flex-col gap-2" style={{ background: "var(--surface-card)", border: EDGE }}>
      <div className="text-[11px]" style={{ color: "var(--text3)" }}>Lantern card preview</div>
      {previewRows(live).map((r) => <AgentCard key={r.name} r={r} quiet cacheTtlMs={lanternCacheTtlMs()} />)}
      {!live.length && <div className="text-[12px]" style={{ color: "var(--text3)" }}>No session is running.</div>}
    </div>
  );
  return (
    <SettingsPage title="Watching" purpose="Let agentglass look at your agents on a schedule and tell you when one needs you." aside={aside}
      sections={[
        { id: "watching", title: "Watching", kind: "normal", body: (
          <Section id="watching" title="Watching" intro="Looks at every session, and tells you only while something needs you.">
            <SettingRow kind="control" settingId="lantern.watch" label="Watch the agents and notify me" help="Sends one notification per look, only while something needs you."
              control={<Sw on={watch} label="Watch the agents and notify me" disabled={off} onFlip={() => change("watch", !watch)} />} />
            <Dep on={watch} reason="Turn on Watch the agents first" settingId="lantern.watchMinutes" label="How often it looks" help="Sets the time between two looks at the board."
              control={<Select value={String(near(WATCH_STEPS, s?.watchMinutes ?? 15))} align="right" options={mins(WATCH_STEPS)} onChange={(v) => change("watchMinutes", Number(v))} />} />
            <SettingRow kind="control" settingId="lantern.cacheTtlMinutes" label="How long the prompt cache stays warm" help="Counts down the cheap window after a session's last turn."
              control={<Select value={String(s?.cacheTtlMinutes === 60 ? 60 : 5)} align="right" options={[{ value: "5", label: "5 min" }, { value: "60", label: "1 hour" }]} onChange={(v) => change("cacheTtlMinutes", Number(v))} />} />
            <SettingRow kind="link" label="Where a notification goes" help="Chooses the bell, the desktop and your phone." linkText="Open Notifications" onOpen={() => openSettings("notifications")} />
            <Problem text={err} />
          </Section>) },
        { id: "sessions", title: "Sessions", kind: "normal", body: (
          <Section id="sessions" title="Sessions" intro={`${live.length} running. The long names wrap; nothing is cut.`}
            action={<Button disabled={!idle.length} onClick={closeIdle}>{`Close idle (${idle.length})`}</Button>}>
            {live.length ? live.map((r) => <SessionLine key={r.name} label={sessionLabel(r)} state={stateOf(r)} />) : <div role="status" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>No session is running.</div>}
          </Section>) },
        { id: "checkins", title: "Session check-ins", kind: "normal", body: (
          <Section id="checkins" title="Session check-ins" intro="Names each job in the session's own words.">
            <SettingRow kind="control" settingId="lantern.nudge" label="Ask sessions what they are working on" help="Asks a session to post its task in one line."
              control={<Sw on={s?.nudge ?? false} label="Ask sessions what they are working on" disabled={off} onFlip={() => change("nudge", !s!.nudge)} />} />
            <Dep on={s?.nudge ?? false} reason="Turn on Ask sessions first" settingId="lantern.nudgeMinutes" label="How often one session may be asked again" help="Leaves a session that answered alone for this long."
              control={<Select value={String(near(ASK_STEPS, s?.minutes ?? 20))} align="right" options={mins(ASK_STEPS)} onChange={(v) => change("minutes", Number(v))} />} />
          </Section>) },
        { id: "hooks", title: "Claude Code hooks", kind: "normal", body: (
          <Section id="hooks" title="Claude Code hooks" intro="Sends what a session does to agentglass. Start a new session after a change.">
            {hooks && (hooks.installed
              ? <SettingRow kind="control" label="Hooks are wired" help="Reports every Claude Code session to agentglass." control={<StatusBadge tone="ok">Wired</StatusBadge>} />
              : <SettingRow kind="control" label="Hooks are not wired" help="Wires the hooks so sessions report to agentglass."
                  control={<Button tone="primary" onClick={() => void wire("install")}>Wire the hooks</Button>} />)}
            {!hooks && !hookErr && <div role="status" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>Reading the hooks…</div>}
            <Problem text={hookErr} />
          </Section>) },
        { id: "danger", title: "Danger zone", kind: "danger", body: (
          <DangerZone>
            <SettingRow kind="control" label="Take the hooks back out" help="Removes the hook entries; running sessions keep them until they end."
              control={<DangerAction label="Take them out" onConfirm={() => wire("uninstall")} />} />
          </DangerZone>) },
      ]}
    />
  );
}
