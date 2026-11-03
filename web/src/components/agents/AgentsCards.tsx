/*
 * The gate card of the Agents page: who is told, and what happens when nobody
 * answers. One line of help each; the long words are behind "Details".
 *
 * The two settings the server keeps come through the settings door
 * (lib/agentDefaults.ts), so a change here and an agent's change are the same
 * write.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { AGENT_DEFAULTS, DOOR_ID, loadDefaults, type AgentDefaults } from "../../lib/agentDefaults.ts";
import {
  GATE_ANSWERERS, GATE_ANSWERER_LABEL, GATE_ON_TIMEOUT, GATE_ON_TIMEOUT_LABEL,
} from "../../../../shared/agentDefaults.ts";
import type { HookSetupStatus } from "../../../../shared/types.ts";
import { Select } from "../Select.tsx";
import { SettingRow, Switch } from "../SettingRow.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { ShieldIcon } from "../settingsNavIcons.tsx";
import { WarningIcon } from "../../lib/glyphIcons.tsx";
import { useReportSaving } from "../SettingsPageState.tsx";

/** The two, read once per open and written one at a time. A refusal comes back as the server's own sentence. */
export function useAgentDefaults(open: boolean) {
  const [d, setD] = useState<AgentDefaults | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("hooks", busy);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadDefaults().then((r) => { if (live) setD(r ?? AGENT_DEFAULTS); });
    return () => { live = false; };
  }, [open]);
  const set = useCallback(async <K extends keyof AgentDefaults>(k: K, v: AgentDefaults[K]): Promise<boolean> => {
    setBusy(true); setNote(null);
    const r = await api.settingsDoorSet(DOOR_ID[k], v).catch(() => ({ ok: false as const, error: "Could not reach the server" } as { ok: boolean; applied?: boolean; error?: string }));
    setBusy(false);
    if (!r.ok) { setNote(r.error ?? "Could not save"); return false; }
    setD((cur) => { const next = { ...(cur ?? AGENT_DEFAULTS), [k]: v }; return next; });
    return true;
  }, []);
  return { d: d ?? AGENT_DEFAULTS, ready: d !== null, set, note, busy };
}

const Note = ({ text }: { text: string | null }) => text
  ? <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div>
  : null;

/* ── Gate ── */

export function GateCard({ st, busy, onGate, open, onShow, showTitle }: {
  st: HookSetupStatus; busy: boolean; onGate: (on: boolean) => void; open: boolean;
  /** The one thing here that lives outside Settings: the board of waiting actions. */
  onShow?: () => void; showTitle?: string;
}) {
  const { d, set, note } = useAgentDefaults(open);
  const off = st.gateBundled && !st.gate;
  return (
    <SettingsCard title="Gate" icon={<ShieldIcon size={ICON.sm} />} tone={off ? "decision" : "default"}
      desc="What may leave this machine, and what happens if nobody answers."
      status={<StatusBadge tone={!st.gateBundled ? "off" : st.gate ? "ok" : "warn"}>{!st.gateBundled ? "Not in this build" : st.gate ? "On" : "Off · needs a decision"}</StatusBadge>}>
      <SettingRow settingId="hooks.gate" label="Ask me before anything leaves this machine"
        hint="A push, a pull request, a review, a comment, a merge or a message waits for your answer."
        detail={{
          summary: "Details",
          body: <>
            An outward action waits here with the text it would send, and nobody answering means it does not happen.
            Everything local — writing code, running tests, cutting a worktree — is never stopped. Until you turn this
            on, that line rests on each agent remembering it.
          </>,
        }}
        onClick={st.gateBundled ? () => onGate(!st.gate) : undefined}
        disabled={!st.gateBundled || busy}
        role={st.gateBundled ? "switch" : undefined}
        ariaChecked={st.gateBundled ? st.gate : undefined}
        control={st.gateBundled ? <Switch on={st.gate} busy={busy} /> : undefined} />
      <SettingRow settingId="gate.answerer" label="Who answers"
        hint="Waiting actions show up in the Agents view first."
        detail={{
          summary: "Details",
          body: <>
            You always decide. With “Me, and tell the orchestrator” its window also gets one line for each waiting action
            (and for each reminder), so it can brief you. It cannot release one: an agent that may be stopped may not
            let itself go. {off ? "Nothing waits until the gate is on." : ""}
          </>,
        }}
        control={
          <Select value={d.gateAnswerer} align="right" className="agx-select outline-none w-[210px] justify-between"
            options={GATE_ANSWERERS.map((v) => ({ value: v, label: GATE_ANSWERER_LABEL[v] }))}
            onChange={(v) => void set("gateAnswerer", v as AgentDefaults["gateAnswerer"])} />} />
      <SettingRow settingId="gate.onTimeout" label="If nobody answers"
        hint={d.gateOnTimeout === "ask" ? "Asks you twice more before the wait ends, then drops it." : "After the wait, the action is dropped, never sent."}
        detail={{
          summary: "Details",
          body: <>
            Either way a waiting action nobody answered does not happen. “Ask me again” repeats the notification at a
            third and two thirds of the wait; it never makes the wait longer, because the hook that waits stops when
            its own window ends.
          </>,
        }}
        control={
          <Segmented track label="If nobody answers" value={d.gateOnTimeout}
            options={GATE_ON_TIMEOUT.map((v) => ({ id: v, label: GATE_ON_TIMEOUT_LABEL[v] }))}
            onChange={(v) => void set("gateOnTimeout", v)} />} />
      {st.gateBundled && (
        <div className="agx-gate-strip" data-on={st.gate ? "" : undefined}>
          {off && <WarningIcon size={ICON.sm} />}
          <div className="agx-gate-strip-main">
            <b>{off ? "Off: nothing is stopped." : "On: an outward action waits for you."}</b>
            <p>{off
              ? "A push, a review, a comment or a message goes out the moment an agent asks. Turn the gate on and it waits for you — only what leaves this machine, never a local edit or a test run."
              : "An outward action stops here with the text it would send, and goes out when you answer. A local edit, a test run or a worktree never waits."}</p>
            <div className="agx-gate-chips" aria-label="What waits">
              {["a push", "a pull request", "a review", "a comment", "a merge", "a message"].map((w) => (
                <span key={w} className="agx-gate-chip">{w}</span>
              ))}
            </div>
          </div>
          {onShow && (
            <div className="agx-gate-dest">
              <span>Waiting actions live in the Agents view.</span>
              <Button onClick={onShow} title={showTitle}>Show it</Button>
            </div>
          )}
        </div>
      )}
      <Note text={note} />
    </SettingsCard>
  );
}