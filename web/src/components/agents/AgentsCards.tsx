/*
 * The cards of the Agents page that carry the choices the mockup draws as
 * compact rows: the gate (who is told, what happens when nobody answers), the
 * new-chat defaults, and the worker roles. One line of help each; the long
 * words are behind "Details".
 *
 * The five server-held settings come through the settings door
 * (lib/agentDefaults.ts), so a change here and an agent's change are the same
 * write.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { AGENT_DEFAULTS, DOOR_ID, loadDefaults, rememberDefaults, type AgentDefaults } from "../../lib/agentDefaults.ts";
import {
  CHAT_MODES, CHAT_MODE_LABEL, CHAT_START_IN, CHAT_START_IN_LABEL, GATE_ANSWERERS, GATE_ANSWERER_LABEL, GATE_ON_TIMEOUT, GATE_ON_TIMEOUT_LABEL,
} from "../../../../shared/agentDefaults.ts";
import { parseDenyRules } from "../../../../shared/launchModes.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { HookSetupStatus, TmuxEngineInfo } from "../../../../shared/types.ts";
import { Select } from "../Select.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { Field, SegControl, SettingsCard, StatusBadge, helpIdFor } from "../SettingsKit.tsx";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { PanesIcon, ShieldIcon, PlugIcon } from "../settingsNavIcons.tsx";
import { useReportSaving } from "../SettingsPageState.tsx";
import { JOB_ORDER } from "../orchestration/orchestrationCopy.ts";

/** The five, read once per open and written one at a time. A refusal comes back as the server's own sentence. */
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
    setD((cur) => { const next = { ...(cur ?? AGENT_DEFAULTS), [k]: v }; rememberDefaults(next); return next; });
    return true;
  }, []);
  return { d: d ?? AGENT_DEFAULTS, ready: d !== null, set, note, busy };
}

const Note = ({ text }: { text: string | null }) => text
  ? <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div>
  : null;

/* ── Gate ── */

export function GateCard({ st, busy, onGate, open }: { st: HookSetupStatus; busy: boolean; onGate: (on: boolean) => void; open: boolean }) {
  const { d, set, note } = useAgentDefaults(open);
  const off = st.gateBundled && !st.gate;
  return (
    <SettingsCard title="Gate" icon={<ShieldIcon size={ICON.sm} />} tone={off ? "decision" : "default"}
      desc="Holds an outward action until somebody decides."
      status={<StatusBadge tone={!st.gateBundled ? "off" : st.gate ? "ok" : "warn"}>{!st.gateBundled ? "Not in this build" : st.gate ? "On" : "Off · needs a decision"}</StatusBadge>}>
      <SettingRow settingId="hooks.gate" label="Hold what leaves this machine"
        hint="A push, a PR, a comment, a merge or a message waits for an answer."
        detail={{
          summary: "Details",
          body: <>
            A pull request, a review, a ticket or a message in a channel waits here with the text it would send, and
            nobody answering means it does not happen. Everything local — writing code, running tests, cutting a
            worktree — is never held. Until you turn this on, that line is held by each agent remembering it.
          </>,
        }}
        actions={st.gateBundled
          ? <Button tone={st.gate ? "danger" : "primary"} disabled={busy} onClick={() => onGate(!st.gate)}>
              {busy ? "Working…" : st.gate ? "Turn the gate off" : "Turn the gate on"}
            </Button>
          : undefined} />
      <SettingRow settingId="gate.answerer" label="Who answers"
        hint="Held actions show up in the Lantern first."
        detail={{
          summary: "Details",
          body: <>
            You always decide. With “Me, and tell the orchestrator” its window also gets one line for each held action
            (and for each reminder), so it can brief you. It cannot release a hold: an agent that can be held may not let
            itself go. {off ? "Nothing is held until the gate is on." : ""}
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
            Either way a held action nobody answered does not happen. “Ask again” repeats the notification at a third and
            two thirds of the wait; it never makes the wait longer, because the hook that holds the agent stops waiting
            when its own window ends.
          </>,
        }}
        control={
          <SegControl label="If nobody answers" value={d.gateOnTimeout}
            options={GATE_ON_TIMEOUT.map((v) => ({ v, label: GATE_ON_TIMEOUT_LABEL[v] }))}
            onPick={(v) => void set("gateOnTimeout", v)} />} />
      <Note text={note} />
    </SettingsCard>
  );
}

/* ── New chats ── */

export function NewChatsCard({ open, tmuxEngine, enginePref, onEngine }: {
  open: boolean;
  tmuxEngine: TmuxEngineInfo | null;
  /** The explicit choice of this window, or null for "whatever the server does". */
  enginePref: "process" | "tmux" | null;
  onEngine: (v: "process" | "tmux" | null) => void;
}) {
  const { d, set, note } = useAgentDefaults(open);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const serverDefault: "process" | "tmux" = tmuxEngine?.defaultOn ? "tmux" : "process";
  const run = enginePref ?? serverDefault;
  const unavailable = tmuxEngine ? !tmuxEngine.available : true;
  const saveRules = async () => {
    const p = parseDenyRules(draft);
    if (p.bad.length) { setErr(`Not a rule: ${p.bad[0]}`); return; }
    setErr(null);
    if (await set("chatDeny", p.rules)) setEditing(false);
  };
  const n = d.chatDeny.length;
  return (
    <SettingsCard title="New chats" icon={<PanesIcon size={ICON.sm} />} desc="What a chat gets when it starts.">
      {/* Merged from a separate "Chat" page: this and the tmux binary answer
          the same question — what a pane actually runs on. */}
      <SettingRow label="How new chats run"
        hint={unavailable && tmuxEngine ? `tmux panes unavailable: ${tmuxEngine.reason}.` : "Each one gets its own session unless you pick panes."}
        detail={{
          summary: "Details",
          body: <>
            Panes keep a warm claude per chat: faster turns, and you can attach from your terminal. Separate takes longer
            per turn and leaves nothing running. {unavailable ? "Chats still run, one process per turn. See Requirements for how to add tmux." : "Picking what the server already does follows the server again."}
          </>,
        }}
        control={
          <SegControl label="How new chats run" value={run} disabled={unavailable}
            options={[{ v: "process" as const, label: "Separate" }, { v: "tmux" as const, label: "tmux panes" }]}
            onPick={(v) => onEngine(v === serverDefault ? null : v)} />} />
      <SettingRow settingId="chats.startIn" label="Starts in" hint="The folder a new chat opens at."
        control={
          <Select value={d.chatStartIn} align="right" className="agx-select outline-none w-[170px] justify-between"
            options={CHAT_START_IN.map((v) => ({ value: v, label: CHAT_START_IN_LABEL[v] }))}
            onChange={(v) => void set("chatStartIn", v as AgentDefaults["chatStartIn"])} />} />
      <SettingRow settingId="chats.mode" label="Permission mode" hint="Applies to chats; terminals have their own."
        detail={{
          summary: "Details",
          body: <>For Claude chats. “Like the open chat” keeps what a new chat always did: it starts in the mode of the chat you had open. Skipping every prompt is not offered here; it stays an opt-in of the server.</>,
        }}
        control={
          <Select value={d.chatMode} align="right" className="agx-select outline-none w-[170px] justify-between"
            options={CHAT_MODES.map((v) => ({ value: v, label: CHAT_MODE_LABEL[v] }))}
            onChange={(v) => void set("chatMode", v as AgentDefaults["chatMode"])} />} />
      <SettingRow settingId="chats.deny" label="Extra deny rules" hint="One pattern per line, added to every new Claude chat. Codex and Antigravity chats do not take deny rules."
        status={n ? <StatusBadge tone="off">{n} {n === 1 ? "rule" : "rules"}</StatusBadge> : undefined}
        actions={editing ? undefined : <Button onClick={() => { setDraft(d.chatDeny.join("\n")); setErr(null); setEditing(true); }}>Edit rules</Button>}
        below={editing ? (
          <div className="agx-sform">
            <Field label="Rules" htmlFor="chat-deny" error={err ?? undefined}
              help={<>Example: <span className="t-mono">Bash(gh pr merge:*)</span>. A rule is checked before the permission mode, on every Claude chat turn.</>}>
              <textarea id="chat-deny" value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} spellCheck={false}
                aria-describedby={helpIdFor("chat-deny")} className={`t-mono w-full ${INPUT}`} style={INPUT_STYLE} />
            </Field>
            <div className="flex gap-2 pt-1">
              <Button tone="primary" onClick={() => void saveRules()}>Save rules</Button>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : undefined} />
      <Note text={note} />
    </SettingsCard>
  );
}

/* ── Worker roles ── */

/** What a role is, in the words under its name. */
const ROLE_BLURB: Record<RoleId, string> = {
  builder: "Writes the change", reviewer: "Reads it adversarially", verifier: "Runs the checks", scout: "Read-only search",
};

type Choice = { provider: string; model: string };

export function WorkerRolesCard({ open, resetTick, onEngines }: { open: boolean; resetTick: number; onEngines: () => void }) {
  const [roles, setRoles] = useState<Record<string, Choice>>({});
  const [clis, setClis] = useState<{ id: string; title: string; installed: boolean }[]>([]);
  const [models, setModels] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const take = (r: { roles?: Record<string, Choice> }) => {
    if (!r.roles) return;
    setRoles(r.roles);
    setModels(Object.fromEntries(Object.entries(r.roles).map(([k, v]) => [k, v.model])));
  };
  useEffect(() => {
    if (!open) return;
    void api.workerRoles().then((r) => { take(r); setClis(r.providers ?? []); })
      .catch(() => setNote("Could not reach the server — the worker roles are unavailable."));
  }, [open, resetTick]);
  const save = (role: string, c: Choice) => {
    setNote(null);
    void api.workerRoleSave(role, c.provider, c.model)
      .then((r) => { if (!r.ok) setNote(r.error ?? "Could not save."); else { take(r); setNote("Saved. Applies to the next worker started in that role."); } })
      .catch(() => setNote("Could not save."));
  };
  return (
    <SettingsCard title="Worker roles" icon={<PlugIcon size={ICON.sm} />}
      desc={<>Which CLI each role runs on. <button type="button" className="agx-field-link" onClick={onEngines}>Which engines this computer has</button></>}>
      {JOB_ORDER.map((id) => {
        const r = WORKER_ROLES.find((x) => x.id === id);
        const c = roles[id];
        if (!r || !c) return null;
        const mid = `role-model-${id}`;
        return (
          <SettingRow key={id} label={r.title} hint={ROLE_BLURB[id]}
            detail={{
              summary: "Model and lock",
              body: <>
                <span className="block mb-2">
                  {r.what}{r.readOnly ? " File edits are refused too." : ""} Locked against push, commit, merge and the network clients,
                  in a layer the project's own config cannot loosen. Default: {r.default.provider}, {r.default.model}.
                </span>
                <div className="agx-sform">
                  <Field label="Model" htmlFor={mid} help="Handed to the CLI as typed. Empty runs its default model.">
                    <input id={mid} value={models[id] ?? ""} placeholder="default model" spellCheck={false}
                      onChange={(e) => setModels((m) => ({ ...m, [id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(id, { provider: c.provider, model: models[id] ?? "" }); } }}
                      onBlur={() => { if ((models[id] ?? "") !== c.model) save(id, { provider: c.provider, model: models[id] ?? "" }); }}
                      aria-describedby={helpIdFor(mid)} className={`t-mono w-full ${INPUT}`} style={INPUT_STYLE} />
                  </Field>
                </div>
              </>,
            }}
            control={
              <Select value={c.provider} align="right" className="agx-select outline-none w-[150px] justify-between"
                options={clis.map((p) => ({ value: p.id, label: p.installed ? p.title : `${p.title} (not installed)` }))}
                onChange={(v) => save(id, { provider: v, model: "" })} />} />
        );
      })}
      {note && <div role="status" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--text3)" }}>{note}</div>}
    </SettingsCard>
  );
}
