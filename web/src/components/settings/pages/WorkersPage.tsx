import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../../lib/api.ts";
import { WORKER_ROLES } from "../../../../../shared/workerRoles.ts";
import { LIMIT_RANGE } from "../../orchestration/orchestrationCopy.ts";
import { REVIEW_ROUNDS_MIN, REVIEW_ROUNDS_MAX } from "../../../../../shared/reviewSettings.ts";
import { CountStepper } from "../../orchestration/SafetyParts.tsx";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section, MoreOptions, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { DangerAction, TextCommitField, instantSave, pushSaveToast } from "../save/index.ts";
import { ScopeControl, ScopeTag } from "../scope/ScopeControl.tsx";
import { ScopeFilter, ScopeLedgerProvider, useReportRow, useScopeLedger } from "../scope/ledger.tsx";
import { LOCKED_TEXT, rootFor, rowTag, type ScopeChoice } from "../scope/scopeModel.ts";

/** Workers: limits, roles, and the one memory ceiling. Rows by ia.md, copy by pattern.md section 5. */
export interface WorkersPageProps {
  limits: { turnMinutes: number; maxWorkers: number; maxRetries: number };
  rounds: number;
  /** Policy rows are read-only while a project follows "All projects", and while a save runs. */
  locked: boolean;
  /** A save is running. */
  busy: boolean;
  /** A project (not "All projects") is selected: the machine memory row is locked. */
  projectScoped: boolean;
  /** The page's one "Applies to" control and what its rows compare against. */
  scope: {
    project: string | null;
    projects: readonly string[];
    onPick: (root: string) => void;
    choice: ScopeChoice;
    onChoice: (next: ScopeChoice) => void;
    /** The values All projects hold; null until read. */
    general: { turnMinutes: number; maxWorkers: number; maxRetries: number; rounds: number } | null;
    /** The project holds a policy of its own. */
    own: boolean;
    /** A quiet line beside the control (the Flight plan link). */
    lead?: ReactNode;
    /** The server's sentence when the last change was refused. */
    note?: string;
  };
  /** Machine rows that keep this page until step 4 moves them to Advanced. Not part of the person rows. */
  machineSlot?: ReactNode;
  /** Absolute value. Undo calls it again with the old one. */
  onLimit: (k: "turnMinutes" | "maxWorkers" | "maxRetries", to: number) => void;
  onRounds: (to: number) => void;
  onOpenRoles: () => void;
  onOpenEngines: () => void;
  onOpenPermissions: () => void;
}

const MEMORY_SIZE = /^\d+(\.\d+)?\s*[KMGT]?B?$/i;
const memoryError = (v: string): string | null => (v.trim() === "" || MEMORY_SIZE.test(v.trim()) ? null : "Use a size like 20G, or leave it empty.");

/** The ceiling on one worker's memory. Empty is automatic; the environment's variable wins and locks the row. */
function MemoryRow({ projectScoped }: { projectScoped: boolean }) {
  const [value, setValue] = useState("");
  const [env, setEnv] = useState<{ name: string; value: string } | null>(null);
  useEffect(() => {
    let live = true;
    void api.settingAtGlobal("workers.memoryMax").then((r) => {
      if (!live || !r.ok) return;
      setValue(typeof r.value === "string" ? r.value : "");
      setEnv(r.env ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const write = useCallback(async (to: string, back: string) => {
    const r = await api.settingsDoorSet("workers.memoryMax", to.trim()).catch(() => ({ ok: false, applied: false as boolean | undefined }));
    if (!r.ok || r.applied === false) { setValue(back); pushSaveToast(r.ok ? "That change waits for you on the requests card" : "Could not save it", () => setValue(back)); return; }
    setValue(to.trim());
  }, []);
  const save = (to: string) => {
    const old = value;
    if (to.trim() === old) return;
    void write(to, old).then(() => pushSaveToast("Saved · applies to workers started next", () => { void write(old, to.trim()); }));
  };
  const field = <TextCommitField label="Memory one worker may hold" value={value} placeholder="automatic, or like 20G" mono validate={memoryError} onSave={save} />;
  const help = "Stops a worker that grows past this size. Empty picks a share of your RAM.";
  const reason = env ? "Set by the environment" : projectScoped ? LOCKED_TEXT : null;
  return (
    <SettingRow {...(reason ? { kind: "locked" as const, reason } : { kind: "control" as const })}
      settingId="workers.memoryMax" label="Memory one worker may hold" help={help} control={field} />
  );
}

/** Put every role back on its default CLI and model. */
function ForgetRolesRow() {
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    const rs = await Promise.all(WORKER_ROLES.map((r) => api.workerRoleSave(r.id, r.default.provider, r.default.model).then((x) => x.ok).catch(() => false)));
    setNote(rs.every(Boolean) ? "Done. Every role is back on its default." : "Could not reset every role.");
  };
  return (
    <SettingRow kind="control" agentExempt label="Forget worker roles" help="Puts every role back on its default engine and model."
      control={<div className="flex items-center gap-2">{note && <span role="status" className="text-[11px]" style={{ color: "var(--text2)" }}>{note}</span>}<DangerAction label="Forget roles" onConfirm={() => void run()} /></div>} />
  );
}

type LimitId = "turnMinutes" | "maxWorkers" | "maxRetries" | "reviewRounds";

/** A per-project row: the tag under it, its reset, and the count the header keeps. */
function ScopedRow({ id, label, value, general, own, choice, onReset, children }: {
  id: LimitId; label: string; value: number; general: number | undefined; own: boolean; choice: ScopeChoice; onReset: (to: number) => void; children: ReactNode;
}) {
  const tag = rowTag({ id, general: general ?? value, own: own && general !== undefined && value !== general ? value : undefined }, choice, (v) => String(v));
  useReportRow(`${id}:${label}`, tag.kind === "differs");
  return (
    <ScopeFilter differs={tag.kind === "differs"}>
      {children}
      {tag.kind !== "none" && general !== undefined && (
        <div className="px-3 pb-2" data-scope-row={id}><ScopeTag tag={tag} onReset={() => onReset(general)} /></div>
      )}
    </ScopeFilter>
  );
}

export function WorkersPage(p: WorkersPageProps) {
  const { ledger, summary } = useScopeLedger(p.scope.choice);
  const g = p.scope.general;
  const scoped = (id: LimitId, label: string, value: number, onReset: (to: number) => void, row: ReactNode) => (
    <ScopedRow id={id} label={label} value={value} general={g?.[id === "reviewRounds" ? "rounds" : id]} own={p.scope.own} choice={p.scope.choice} onReset={onReset}>{row}</ScopedRow>
  );
  const stepper = (id: "turnMinutes" | "maxWorkers" | "maxRetries", label: string) => (
    <CountStepper id={id} value={p.limits[id]} min={LIMIT_RANGE[id].min} max={LIMIT_RANGE[id].max} label={label} disabled={p.locked}
      onChange={(v) => instantSave(p.limits[id], v, (n) => p.onLimit(id, n))} />
  );
  const sections: PageSection[] = [
    {
      id: "limits", title: "Limits", kind: "normal",
      body: (
        <Section id="limits" title="Limits" intro="Counted per task. Applied to every worker this project starts.">
          {scoped("maxWorkers", "Workers at once", p.limits.maxWorkers, (to) => p.onLimit("maxWorkers", to),
            <SettingRow kind="control" agentExempt label="Workers at once" help="How many workers may run together." control={stepper("maxWorkers", "workers at once")} />)}
          {scoped("turnMinutes", "Minutes per turn", p.limits.turnMinutes, (to) => p.onLimit("turnMinutes", to),
            <SettingRow kind="control" agentExempt label="Minutes per turn" help="Stops a worker that runs longer than this." control={stepper("turnMinutes", "minutes per turn")} />)}
          {scoped("reviewRounds", "Review rounds", p.rounds, p.onRounds,
            <SettingRow kind="control" settingId="orchestration.review.rounds" label="Review rounds" help="How many fix-and-review rounds before a worker stops."
              control={<CountStepper id="reviewRounds" value={p.rounds} min={REVIEW_ROUNDS_MIN} max={REVIEW_ROUNDS_MAX} label="Review rounds" disabled={p.busy}
                onChange={(v) => instantSave(p.rounds, v, p.onRounds)} />} />)}
          <MemoryRow projectScoped={p.projectScoped} />
        </Section>
      ),
    },
    {
      id: "roles", title: "Roles", kind: "normal",
      body: (
        <Section id="roles" title="Roles" intro="Each role picks its engine and model.">
          <SettingRow kind="link" agentExempt label="Roles in this project" help="Builder, reviewer, scout and planner." linkText="Edit roles" onOpen={p.onOpenRoles} />
          <SettingRow kind="link" agentExempt label="Role engines" help="Which engine each role uses." linkText="Edit roles" onOpen={p.onOpenEngines} />
          <SettingRow kind="link" agentExempt label="What a worker may do" help="Its level, its commands and its sandbox." linkText="Open permissions" onOpen={p.onOpenPermissions} />
        </Section>
      ),
    },
    {
      id: "more", title: "More options", kind: "more",
      body: (
        <MoreOptions>
          {scoped("maxRetries", "Retries with the next engine", p.limits.maxRetries, (to) => p.onLimit("maxRetries", to),
            <SettingRow kind="control" agentExempt label="Retries with the next engine" help="Tries another engine when the first one fails." control={stepper("maxRetries", "retries")} />)}
        </MoreOptions>
      ),
    },
    ...(p.machineSlot ? [{ id: "machine", title: "Machine settings", kind: "more" as const, body: <MoreOptions id="machine" title="Machine settings">{p.machineSlot}</MoreOptions> }] : []),
    { id: "danger", title: "Danger zone", kind: "danger", body: <DangerZone><ForgetRolesRow /></DangerZone> },
  ];
  const sc = p.scope;
  const scopeSlot = (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ScopeControl project={sc.project} projects={sc.projects} value={sc.choice} onChange={sc.onChoice} onPick={sc.onPick} />
        {sc.lead}
      </div>
      {summary}
      {sc.note && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{sc.note}</div>}
    </div>
  );
  return (
    <ScopeLedgerProvider ledger={ledger}>
      <SettingsPage title="Workers" purpose="How many workers run at once, how long they may take, and which role each one plays." scopeSlot={scopeSlot} scopeKey={rootFor(sc.choice, sc.project)} sections={sections} />
    </ScopeLedgerProvider>
  );
}
