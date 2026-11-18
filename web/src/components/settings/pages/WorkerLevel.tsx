import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { Button, Segmented } from "../../workspace/Chrome.tsx";
import { Switch } from "../../SettingRow.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { ListEditor, pushSaveToast, useLoosenGate, droppedRefusals, envLoosens, sayList } from "../save/index.ts";
import { LEVELS } from "../../orchestration/flow/FlowSections.tsx";
import { DENIED_COMMANDS } from "../../../../../shared/workerRoles.ts";
import type { Envelope, Policy } from "../../../../../shared/orchestration.ts";

type Col = "workerDefault" | "ceiling";
type Loaded = { policy: Policy; scope: "project" | "global" };

const Sw = ({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled: boolean; onFlip: () => void }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onFlip}
    className="agx-switch-hit inline-flex items-center rounded-full"><Switch on={on} /></button>
);
/** A control with the column it belongs to written beside it. */
const Col2 = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text2)" }}>{name}{children}</span>
);
const lines = (a: string[]) => a.join("\n");
const parse = (t: string) => [...new Set(t.split("\n").map((l) => l.trim()).filter(Boolean))];

/** The worker level, what each column may do, and the two refuse lists, as rows of Permissions. Each change saves the whole policy at once, with Undo. */
export function WorkerLevel({ root, open }: { root: string; open: boolean }) {
  const [st, setSt] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const g = useLoosenGate();
  const load = useCallback(() => {
    setFailed(false);
    void api.orchestration(root || undefined).then((r) => { if (r.ok) setSt({ policy: r.policy, scope: r.scope }); else setFailed(true); }).catch(() => setFailed(true));
  }, [root]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const write = useCallback(async (next: Policy | null, undo: Policy | null) => {
    setBusy(true); setNote(null);
    const r = await api.orchestrationSave(next, root || undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    setBusy(false);
    if (!r.ok || !("policy" in r) || !r.policy) { setNote(r.error ?? "Could not save it"); return; }
    setSt({ policy: r.policy, scope: r.scope ?? "global" });
    // Undo puts the old policy back; if that loosens (a switch turned off, a refusal added), it asks like any loosening change.
    const back = undo ? envLoosens(r.policy, undo) : null;
    pushSaveToast("Saved", () => g.gate("level", back, () => void write(undo, next)));
  }, [root, g.gate]);
  // A question built for one project or scope must not be answered in another: its policy and root are the old ones.
  const scopeNow = st?.scope;
  useEffect(() => { g.cancel(); }, [root, scopeNow, g.cancel]);

  if (failed) return <SettingRow kind="control" agentExempt label="Could not load the worker level" help="The limits did not load, so none are shown." control={<Button onClick={load}>Retry</Button>} />;
  if (!st) return <SettingRow kind="control" agentExempt label="Worker level" help="Reading the limits." control={<span role="status" className="text-[12px]" style={{ color: "var(--text2)" }}>Reading…</span>} />;

  const { policy } = st;
  /** What a change to the policy would loosen, in words, or null when it only narrows. */
  const whatLoosens = (next: Partial<Policy>): string | null => envLoosens(policy, next);
  const inherited = !!root && st.scope !== "project";
  const off = busy || inherited;
  const env = (c: Col) => policy[c];
  /** A refusal list asks inside its own editor: dropping a line allows what it refused. */
  const refusalsDropped = (before: string, next: string): string | null => { const gone = droppedRefusals(before, next); return gone.length ? `run ${sayList(gone)}` : null; };
  /** A change that loosens asks on its row first; one that narrows saves at once, with Undo. */
  const set = (patch: Partial<Policy>, row = "level") => g.gate(row, whatLoosens(patch), () => void write({ ...policy, ...patch }, policy));
  const edit = (c: Col, patch: Partial<Envelope>, row: string) => set({ [c]: { ...policy[c], ...patch } } as Partial<Policy>, row);
  const both = (patch: Partial<Envelope>, row: string) => set({ workerDefault: { ...policy.workerDefault, ...patch }, ceiling: { ...policy.ceiling, ...patch } }, row);
  const d = policy.workerDefault;
  const nowLevel = LEVELS.find((l) => l.env.write === d.write && l.env.commit === d.commit && l.env.network === d.network && l.env.docker === d.docker)?.id ?? "custom";
  const alert = note ? <div role="alert" className="px-3 pb-2.5 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div> : null;

  const writeSeg = (c: Col) => (
    <Col2 name={c === "workerDefault" ? "Default" : "Ceiling"}>
      <Segmented label={`Write files, ${c === "workerDefault" ? "default" : "ceiling"}`} value={env(c).write} disabled={off}
        options={[{ id: "none", label: "Nothing" }, { id: "worktree", label: "Its own copy" }]} onChange={(w) => edit(c, { write: w }, "write")} />
    </Col2>
  );
  const pair = (label: string, key: "commit" | "network") => (
    <>
      <Col2 name="Default"><Sw on={!!d[key]} label={`${label}, default`} disabled={off} onFlip={() => edit("workerDefault", { [key]: !d[key] }, key)} /></Col2>
      <Col2 name="Ceiling"><Sw on={!!policy.ceiling[key]} label={`${label}, ceiling`} disabled={off} onFlip={() => edit("ceiling", { [key]: !policy.ceiling[key] }, key)} /></Col2>
    </>
  );
  const joint = (label: string, key: "docker" | "worktreeOps") => (
    <Col2 name="Default and ceiling"><Sw on={!!d[key]} label={`${label}, default and ceiling`} disabled={off} onFlip={() => both({ [key]: !d[key] }, key)} /></Col2>
  );

  return (
    <>
      {inherited && (
        <SettingRow kind="control" agentExempt label="This project uses the all-projects limits" help="Make them its own to change them here."
          control={<Button disabled={busy} onClick={() => void write(policy, null)}>Make specific</Button>} />
      )}
      <SettingRow kind="control" agentExempt label="Worker level" help="Sets what a new worker starts with; Docker has its own switch." tag={g.at("level")}
        control={<Segmented label="Worker level" value={nowLevel} disabled={off}
          options={LEVELS.map((l) => ({ id: l.id, label: l.title }))}
          onChange={(id) => { const l = LEVELS.find((x) => x.id === id); if (l) set({ workerDefault: { ...policy.workerDefault, ...l.env } }); }} />} />
      <SettingRow kind="control" agentExempt label="Write files" help="Never wider than the worker's own copy of the project." tag={g.at("write")} control={<>{writeSeg("workerDefault")}{writeSeg("ceiling")}</>} />
      <SettingRow kind="control" agentExempt label="Commit" help="Lets a worker commit in its own copy." tag={g.at("commit")} control={pair("Commit", "commit")} />
      <SettingRow kind="control" agentExempt label="Network" help="Lets a worker reach the internet." tag={g.at("network")} control={pair("Network", "network")} />
      <SettingRow kind="control" agentExempt label="Docker" help="A container shares this machine, so it starts off." tag={g.at("docker")} control={joint("Docker", "docker")} />
      <SettingRow kind="control" agentExempt label="Worktree operations" help="Lets a worker merge, reset, check out or clean its copy." tag={g.at("worktreeOps")} control={joint("Worktree ops", "worktreeOps")} />
      <SettingRow kind="control" agentExempt label="Most allowed: also refuse" help="Adds refusals that no role can open."
        control={<ListEditor label="Most allowed: also refuse" value={lines(policy.ceiling.deny)} placeholder="a command to refuse"
          loosens={refusalsDropped} resetKey={`${root}|${st.scope}`} onSave={(v) => void write({ ...policy, ceiling: { ...policy.ceiling, deny: parse(v) } }, policy)} />} />
      <SettingRow kind="control" agentExempt label="Also refused here" help={root ? "Adds refusals for this project's workers only." : "Adds refusals for every project's workers."}
        control={<ListEditor label="Also refused here" value={lines(policy.workerDefault.deny)} placeholder="a command to refuse"
          loosens={refusalsDropped} resetKey={`${root}|${st.scope}`} onSave={(v) => void write({ ...policy, workerDefault: { ...policy.workerDefault, deny: parse(v) } }, policy)} />} />
      {alert}
      <div className="px-3 py-2.5 text-[12px]" data-never-allowed style={{ color: "var(--text2)" }}>
        <div className="font-medium" style={{ color: "var(--text)" }}>Always refused</div>
        <div>No setting, rule or agent can open these, in any project.</div>
        <div className="mt-1 flex flex-wrap gap-1.5">{DENIED_COMMANDS.map((c) => <code key={c} className="t-mono rounded px-1.5 py-0.5" style={{ background: "var(--surface-inset)" }}>{c}</code>)}</div>
      </div>
    </>
  );
}
