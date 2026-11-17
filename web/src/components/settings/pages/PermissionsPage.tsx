import { WorkerLevel } from "./WorkerLevel.tsx";
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { ListEditor, instantSave, useLoosenGate, droppedRefusals, addedGrants, sayList } from "../save/index.ts";
import { Switch } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { Button, INPUT, INPUT_STYLE, Segmented } from "../../workspace/Chrome.tsx";
import { HIT } from "../../../lib/iconSize.ts";
import { api, serverIsTokenless, type GuideGrantRow, type GuideGrantsReply } from "../../../lib/api.ts";
import { clickupSetup, __forgetClickupSetup } from "../../../lib/clickupSetup.ts";
import { noteJiraSettings, useJiraSettings } from "../../../lib/jiraSettings.ts";
import { setLaunchPermissions } from "../../../lib/launchMode.ts";
import { REFUSAL_WHERE, type RefusalLayer } from "../../../../../shared/refusal.ts";
import { LAUNCH_MODES, LAUNCH_MODE_LABEL, isLaunchMode, parseDenyRules, type LaunchMode } from "../../../../../shared/launchModes.ts";
import { BROWSER_ENGINES, BROWSER_ROLES, SEAT_ROW_LABEL, CARD_TABS_ROW_LABEL, groupFlowRoleRows, type BrowserWorkers, type FlowRoleCardRow } from "../../../../../shared/browserWorkers.ts";
import { WORKER_VERB_GROUPS } from "../../../../../shared/browserLimits.ts";
import { SWITCHABLE_COMMANDS } from "../../../../../shared/workerRoles.ts";
import type { JiraStatus } from "../../../../../shared/providers.ts";
import type { HookSetupStatus } from "../../../../../shared/types.ts";
import { GATE_ANSWERERS, GATE_ANSWERER_LABEL, GATE_ON_TIMEOUT, GATE_ON_TIMEOUT_LABEL } from "../../../../../shared/agentDefaults.ts";
import { useAgentDefaults } from "../../agents/AgentsCards.tsx";
import type { AgentDefaults } from "../../../lib/agentDefaults.ts";
import type { PageCtx } from "./ctx.ts";
import { ScopeControl, ScopeTag } from "../scope/ScopeControl.tsx";
import { MachineLock, ScopeFilter, ScopeLedgerProvider, useReportRow, useScopeLedger } from "../scope/ledger.tsx";
import { useScope } from "../scope/useScope.ts";
import { rowTag, type ScopeChoice, type ScopeRow } from "../scope/scopeModel.ts";
import { usePageLoading } from "../shell/pageLoad.tsx";

/* The one Permissions page. Every setting keeps its id and its store; only the
   shell around it is new. Rows are control rows or link rows. Nothing here is
   a Save button: a switch, a select or a list change saves at once with Undo. */

const AGENT_DOORS = ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"] as const;
const DOOR_IDS = new Set<string>(AGENT_DOORS);
const SHELL_COMMANDS = SWITCHABLE_COMMANDS.filter((c) => !DOOR_IDS.has(c));
const doorKey = (cmd: string) => cmd.replace(/ /g, "-");

type WriteResult = { ok: boolean; applied?: boolean; error?: string };
const NO_SERVER: WriteResult = { ok: false, error: "Could not reach the server" };
const WAITS = "That change waits for you on the requests card.";

/** A switch that is one button: the row label names it. */
function Sw({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled?: boolean; onFlip: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onFlip} style={{ minHeight: HIT }}
      className="agx-switch-hit inline-flex items-center rounded-full"><Switch on={on} /></button>
  );
}

/** A row's error, shown under the page content of its section. */
function Problem({ text }: { text: string | null }) {
  return text ? <div role="alert" className="px-3 pb-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div> : null;
}

/** A boolean setting read and written through the settings door, for one project or for all. */
function useDoorBool(id: string, root: string, whenUnset: boolean, guard?: (v: boolean, run: () => void) => void) {
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** What all projects hold, and whether this project holds a value of its own. */
  const [general, setGeneral] = useState<boolean | null>(null);
  const [scoped, setScoped] = useState(false);
  useEffect(() => {
    let live = true;
    setOn(null);
    const asBool = (r: { ok: boolean; value?: unknown }) => (r.ok ? (r.value === undefined ? whenUnset : r.value === true) : whenUnset);
    void api.settingAtGlobal(id).then((r) => { if (live) setGeneral(asBool(r)); }).catch(() => { if (live) setGeneral(whenUnset); });
    const read = root ? api.settingAt(id, root) : api.settingAtGlobal(id);
    void read.then((r) => {
      if (!live) return;
      setOn(asBool(r));
      setScoped(!!root && !!(r as { scopedSet?: boolean }).scopedSet);
    }).catch(() => { if (live) setOn(whenUnset); });
    return () => { live = false; };
  }, [id, root, whenUnset]);
  usePageLoading(`door/${id}`, on === null);
  const write = useCallback(async (v: boolean): Promise<boolean> => {
    const r: WriteResult = await api.settingAtSet(id, v, root).catch(() => NO_SERVER);
    if (!r.ok) { setErr(r.error ?? "Could not save it"); return false; }
    if (r.applied === false) { setErr(WAITS); return false; }
    setErr(null); setOn(v); setScoped(!!root); return true;
  }, [id, root]);
  // The forward flip was already asked about on its row; Undo and Reset put a value back, and turning a power on that way asks too.
  const back = (v: boolean) => (guard ? guard(v, () => void write(v)) : void write(v));
  const flip = useCallback(() => { if (on !== null) instantSave(on, !on, (v) => (v === !on ? void write(v) : back(v))); }, [on, write, guard]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Reset to all projects: the project takes the general value again, with Undo. */
  const reset = useCallback(() => { if (on !== null && general !== null) instantSave(on, general, back); }, [on, general, write, guard]); // eslint-disable-line react-hooks/exhaustive-deps
  const row: ScopeRow<boolean> = { id, general: general ?? false, own: root && scoped && on !== null && on !== general ? on : undefined };
  return { on, err, flip, reset, row };
}

function DoorSwitchRow({ id, root, choice, label, help, whenUnset = false, allows }: { id: string; root: string; choice: ScopeChoice; label: string; help: string; whenUnset?: boolean; /** What turning it on lets agents do ("x" of "Workers can x"): turning it on asks first. */ allows?: string }) {
  const g = useLoosenGate();
  const { on, err, flip, reset, row } = useDoorBool(id, root, whenUnset, (v, run) => g.gate("row", allows && v ? allows : null, run));
  const tag = rowTag(row, choice, (v) => (v ? "on" : "off"));
  useReportRow(id, tag.kind === "differs");
  return (
    <ScopeFilter differs={tag.kind === "differs"}>
      <SettingRow kind="control" label={label} help={help} tag={<><ScopeTag tag={tag} onReset={reset} />{g.at("row")}</>} control={<Sw on={on === true} label={label} disabled={on === null} onFlip={() => g.gate("row", allows && on === false ? allows : null, flip)} />} />
      <Problem text={err} />
    </ScopeFilter>
  );
}

/** Test a command: ask the server which layer would decide. */
function CheckCommand({ project }: { project: string | null }) {
  const [cmd, setCmd] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const ask = async () => {
    const command = cmd.trim();
    if (!command) { setAnswer(null); return; }
    if (!project) { setAnswer("Open a project first."); return; }
    const r = await api.seatCan(project, command).catch(() => null);
    if (!r?.ok) { setAnswer(r?.error ?? "The server did not answer."); return; }
    setAnswer(r.answer === "allowed"
      ? "Allowed. This is the server's own answer: the worker lock, agent rules and the Gate."
      : `${r.answer === "ask" ? "Would ask you" : "Refused"} by the ${r.layer} layer: ${r.rule ?? r.text ?? ""}. ${REFUSAL_WHERE[r.layer as RefusalLayer] ?? ""}`);
  };
  const name = (r: string) => r.split("/").filter(Boolean).pop() ?? r;
  const commandField = (
    <input value={cmd} onChange={(e) => { setCmd(e.target.value); setAnswer(null); }} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
      aria-label="Command to check" placeholder="git push origin main" spellCheck={false} className={`w-[260px] t-mono ${INPUT}`} style={INPUT_STYLE} />
  );
  return (
    <>
      <SettingRow kind="control" label="Command" help="Type a command to see if a new worker could run it."
        control={<div className="flex items-center gap-2">{commandField}<Button onClick={() => void ask()}>Check</Button></div>} />
      {answer && <div role="status" data-check-answer className="px-3 pb-2 text-[12px]" style={{ color: "var(--text2)" }}>{answer}</div>}
    </>
  );
}

/** Launch permissions: the mode (instant) and the Always deny list (one change at a time). */
function LaunchPermissions({ open }: { open: boolean }) {
  const [mode, setMode] = useState<LaunchMode>("default");
  const [deny, setDeny] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  usePageLoading("launch/permissions", open && !answered);
  useEffect(() => {
    if (!open) return;
    void api.launchPermissions().then((r) => { setMode(r.mode); setDeny(r.deny.join("\n")); setLaunchPermissions({ mode: r.mode, deny: r.deny }); setErr(null); })
      .catch(() => setErr("Could not reach the server, so this setting is unavailable."))
      .finally(() => setAnswered(true));
  }, [open]);
  const write = async (p: { mode?: LaunchMode; deny?: string }) => {
    const r = await api.launchPermissionsSave(p).catch(() => null);
    if (!r?.ok) { setErr(r?.error ?? "Could not save that."); return; }
    setErr(null); setMode(r.mode); setDeny(r.deny.join("\n")); setLaunchPermissions({ mode: r.mode, deny: r.deny });
  };
  return (
    <>
      <SettingRow agentNever="the permission mode every agent the app starts runs in: loosening it is an escalation, so only the owner changes it" kind="control" label="Permission mode" help="Sets how every terminal that starts an agent asks for approval."
        control={<Segmented track label="Permission mode" value={mode}
          onChange={(v) => { if (isLaunchMode(v)) instantSave(mode, v, (m) => void write({ mode: m }), { message: "Saved · applies to the next terminal" }); }}
          options={LAUNCH_MODES.map((m) => ({ id: m, label: LAUNCH_MODE_LABEL[m] }))} />} />
      <SettingRow agentNever="what every agent the app starts may never do: an agent does not edit its own leash" kind="control" label="Always deny" help="Blocks these tools in every terminal, whatever the mode."
        control={<span />} />
      <div className="px-3 pb-3">
        <ListEditor label="Always deny" value={deny} placeholder="Bash(gh pr merge:*)"
          validate={(item) => (parseDenyRules(item).bad.length ? "Not a rule" : null)}
          onSave={(next) => void write({ deny: next })} />
      </div>
      <Problem text={err} />
    </>
  );
}

/** Worker commands: the shell commands a project closes, and the agentglass tools it opens. */
function WorkerCommands({ root, choice }: { root: string; choice: ScopeChoice }) {
  const [closed, setClosed] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The lists all projects hold, to say whether this project differs. */
  const [general, setGeneral] = useState<{ closed: string; opened: string } | null>(null);
  const load = useCallback(async () => {
    const read = (id: string) => api.settingAt(id, root).catch(() => null);
    if (root) {
      const g = (id: string) => api.settingAtGlobal(id).catch(() => null);
      const [gc, gd] = await Promise.all([
        Promise.all(SHELL_COMMANDS.map((cmd) => g(`workers.commands.${doorKey(cmd)}`))),
        Promise.all(AGENT_DOORS.map((door) => g(`workers.appDoors.${door}`))),
      ]);
      setGeneral({
        closed: SHELL_COMMANDS.filter((_, i) => gc[i]?.ok && gc[i]!.value === false).join("\n"),
        opened: AGENT_DOORS.filter((_, i) => gd[i]?.ok && gd[i]!.value === true).join("\n"),
      });
    } else setGeneral(null);
    const [c, d] = await Promise.all([
      Promise.all(SHELL_COMMANDS.map((cmd) => read(`workers.commands.${doorKey(cmd)}`))),
      Promise.all(AGENT_DOORS.map((door) => read(`workers.appDoors.${door}`))),
    ]);
    setClosed(SHELL_COMMANDS.filter((_, i) => c[i]?.ok && c[i]!.value === false).join("\n"));
    setOpened(AGENT_DOORS.filter((_, i) => d[i]?.ok && d[i]!.value === true).join("\n"));
  }, [root]);
  useEffect(() => { setClosed(null); setOpened(null); void load(); }, [load]);
  usePageLoading("workers/doors", closed === null || opened === null);
  const diff = async (before: string, next: string, ids: readonly string[], idOf: (x: string) => string, valueWhenListed: boolean) => {
    const was = new Set(before.split("\n").filter(Boolean));
    const now = new Set(next.split("\n").filter(Boolean));
    let problem: string | null = null;
    for (const item of ids) {
      if (was.has(item) === now.has(item)) continue;
      const r: WriteResult = await api.settingAtSet(idOf(item), now.has(item) ? valueWhenListed : !valueWhenListed, root).catch(() => NO_SERVER);
      if (!r.ok) problem = r.error ?? "Could not save it"; else if (r.applied === false) problem = WAITS;
    }
    setErr(problem);
    await load();
  };
  const known = (list: readonly string[]) => (item: string) => (list.includes(item) ? null : "Not a rule");
  const sameSet = (a: string, b: string) => [...new Set(a.split("\n"))].sort().join() === [...new Set(b.split("\n"))].sort().join();
  const listTag = (id: string, own: string | null, gen: string | undefined, reset: () => void) => {
    const row: ScopeRow<string> = { id, general: gen ?? "", own: root && own !== null && gen !== undefined && !sameSet(own, gen) ? own : undefined };
    const tag = rowTag(row, choice, (v) => v.split("\n").filter(Boolean).join(", ") || "none");
    return { tag, node: <ScopeTag tag={tag} onReset={reset} /> };
  };
  const closedTag = listTag("workers.commands", closed, general?.closed, () => { if (closed !== null && general) void diff(closed, general.closed, SHELL_COMMANDS, (c) => `workers.commands.${doorKey(c)}`, false); });
  const openedTag = listTag("workers.appDoors", opened, general?.opened, () => { if (opened !== null && general) void diff(opened, general.opened, AGENT_DOORS, (d) => `workers.appDoors.${d}`, true); });
  useReportRow("workers.commands", closedTag.tag.kind === "differs");
  useReportRow("workers.appDoors", openedTag.tag.kind === "differs");
  return (
    <>
      <ScopeFilter differs={closedTag.tag.kind === "differs"}>
      <SettingRow kind="control" label="Commands a worker may not run" help="Closes a command for every worker in this scope." tag={closedTag.node} control={<span />} />
      <div className="px-3 pb-3">
        {closed === null ? <span className="text-[12px]" style={{ color: "var(--text2)" }}>Reading…</span>
          : <ListEditor label="Commands a worker may not run" value={closed} placeholder="git push" validate={known(SHELL_COMMANDS)}
            loosens={(before, next) => { const d = droppedRefusals(before, next); return d.length ? `run ${sayList(d)}` : null; }}
            onSave={(next, before) => void diff(before, next, SHELL_COMMANDS, (c) => `workers.commands.${doorKey(c)}`, false)} />}
      </div>
      </ScopeFilter>
      <ScopeFilter differs={openedTag.tag.kind === "differs"}>
      <SettingRow kind="control" label="Which agentglass tools a worker may run" help="Lifts the shell block on a tool; the tool still checks the caller." tag={openedTag.node} control={<span />} />
      <div className="px-3 pb-3">
        {opened === null ? <span className="text-[12px]" style={{ color: "var(--text2)" }}>Reading…</span>
          : <ListEditor label="Which agentglass tools a worker may run" value={opened} placeholder="agentglass-ui" validate={known(AGENT_DOORS)}
            loosens={(before, next) => { const a = addedGrants(before, next); return a.length ? `run ${sayList(a)}` : null; }}
            onSave={(next, before) => void diff(before, next, AGENT_DOORS, (d) => `workers.appDoors.${d}`, true)} />}
      </div>
      </ScopeFilter>
      <Problem text={err} />
    </>
  );
}

/** A row of toggle chips: one per item, each saves at once. */
function Chips({ items, on, label, disabled, onFlip }: { items: readonly { id: string; title: string }[]; on: (id: string) => boolean; label: string; disabled: boolean; onFlip: (id: string) => void }) {
  return (
    <div className="flex flex-wrap justify-end gap-2" role="group" aria-label={label}>
      {items.map((x) => (
        <Button key={x.id} size="compact" on={on(x.id)} aria-pressed={on(x.id)} aria-label={`${x.title}, ${on(x.id) ? "on" : "off"}`} disabled={disabled} onClick={() => onFlip(x.id)}>{x.title}</Button>
      ))}
    </div>
  );
}

/** Who may drive the browser: engines, roles, the seat, card tabs and flow roles. */
function BrowserDrivers({ open }: { open: boolean }) {
  const [granted, setGranted] = useState<BrowserWorkers | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [flowRows, setFlowRows] = useState<FlowRoleCardRow[]>([]);
  // A server with no token identifies nobody, so every rule here is advisory there. Read once: it cannot change without a restart.
  const [tokenless, setTokenless] = useState(false);
  useEffect(() => { void serverIsTokenless().then(setTokenless); }, []);
  // `granted` is null both before the read and when nothing is granted, so "answered" is its own flag.
  const [answered, setAnswered] = useState(false);
  const [flowAnswered, setFlowAnswered] = useState(false);
  usePageLoading("browser/workers", open && !answered);
  usePageLoading("browser/flow-roles", !flowAnswered);
  const load = useCallback(() => {
    void api.settingAtGlobal("browser.workers").then((r) => { if (r.ok) { setGranted((r.value as BrowserWorkers | undefined) ?? null); setLoadFailed(false); } else setLoadFailed(true); }).catch(() => setLoadFailed(true)).finally(() => setAnswered(true));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    let live = true;
    void api.projects().then(async (p) => {
      const rows = (await Promise.all((p.workspaces ?? []).map(async (root) => {
        const got = await api.getFlow(root).catch(() => null);
        if (!got?.ok) return [];
        const project = root.split("/").filter(Boolean).pop() ?? root;
        return got.flow.roster.filter((r) => !BROWSER_ROLES.some((b) => b.id === r.id))
          .map((r) => ({ root, project, id: r.id, title: r.name, base: r.policyRole ?? "", onPath: got.flow.path.includes(r.id) }));
      }))).flat();
      if (live) setFlowRows(rows);
    }).catch(() => undefined).finally(() => { if (live) setFlowAnswered(true); });
    return () => { live = false; };
  }, []);
  const g = useLoosenGate();
  /** What a browser grant change opens, in words, or null when it only closes. */
  const opens = (old: BrowserWorkers, next: BrowserWorkers): string | null => {
    const words: string[] = [];
    const eng = addedGrants(old.engines, next.engines); if (eng.length) words.push(`use the browser from ${sayList(eng)}`);
    const rol = addedGrants(old.roles, next.roles); if (rol.length) words.push(`drive the browser as ${sayList(rol)}`);
    if (old.seat === false && next.seat !== false) words.push("let the orchestrator pane use the browser");
    if (old.cardTabs === false && next.cardTabs !== false) words.push("let a card's tab use the browser");
    for (const [root, m] of Object.entries(next.flowRoles ?? {})) for (const [id, v] of Object.entries(m)) if (v && !old.flowRoles?.[root]?.[id]) words.push(`let the ${id} step use the browser`);
    return words.length ? sayList(words) : null;
  };
  const save = (next: BrowserWorkers, row = "browser") => {
    if (!granted) return;
    const old = granted;
    g.gate(row, opens(old, next), () => apply(old, next, row));
  };
  const apply = (old: BrowserWorkers, next: BrowserWorkers, row: string) => {
    const set = async (v: BrowserWorkers) => {
      const r: WriteResult = await api.settingsDoorSet("browser.workers", v).catch(() => NO_SERVER);
      setErr(!r.ok ? r.error || "Could not save it" : r.applied === false ? WAITS : null);
      load();
    };
    // Undo puts the old grants back; reopening one that was closed asks like any grant.
    instantSave(old, next, (v) => (v === next ? void set(v) : g.gate(row, opens(next, v), () => void set(v))));
  };
  const flip = (kind: "engines" | "roles", id: string) => { if (granted) save({ ...granted, [kind]: granted[kind].includes(id) ? granted[kind].filter((x) => x !== id) : [...granted[kind], id] }, kind); };
  const simple = (key: "seat" | "cardTabs") => granted?.[key] !== false;
  const flowOn = (row: { root: string; id: string; base: string }) => {
    if (!granted || !row.base) return false;
    const over = granted.flowRoles?.[row.root]?.[row.id];
    return over !== undefined ? over : granted.roles.includes(row.base);
  };
  const flowItems = groupFlowRoleRows(flowRows).flatMap((s) => [...s.onPath, ...s.offPath]);
  const flipFlow = (key: string) => {
    const row = flowItems.find((r) => `${r.root}::${r.id}` === key);
    if (!granted || !row) return;
    save({ ...granted, flowRoles: { ...granted.flowRoles, [row.root]: { ...granted.flowRoles?.[row.root], [row.id]: !flowOn(row) } } }, "flow");
  };
  const off = !granted;
  return (
    <>
      <SettingRow kind="control" settingId="browser.workers" label="Engines" help="Turns the browser off for a worker CLI; its workers get no credential." tag={g.at("engines")}
        control={<Chips items={BROWSER_ENGINES} on={(id) => granted?.engines.includes(id) ?? false} label="Engines" disabled={off} onFlip={(id) => flip("engines", id)} />} />
      <SettingRow kind="control" label="Roles" help="Chooses which kinds of worker may drive the browser." tag={g.at("roles")}
        control={<Chips items={BROWSER_ROLES} on={(id) => granted?.roles.includes(id) ?? false} label="Roles" disabled={off} onFlip={(id) => flip("roles", id)} />} />
      <SettingRow kind="control" label={SEAT_ROW_LABEL} help="Lets the project's own orchestrator pane use the browser." tag={g.at("seat")}
        control={<Sw on={simple("seat")} label={SEAT_ROW_LABEL} disabled={off} onFlip={() => granted && save({ ...granted, seat: !simple("seat") }, "seat")} />} />
      <SettingRow kind="control" label={CARD_TABS_ROW_LABEL} help="Lets a tab opened from a card, with no role, use the browser." tag={g.at("cardTabs")}
        control={<Sw on={simple("cardTabs")} label={CARD_TABS_ROW_LABEL} disabled={off} onFlip={() => granted && save({ ...granted, cardTabs: !simple("cardTabs") }, "cardTabs")} />} />
      {flowItems.length > 0 && (
        <SettingRow kind="control" label="Flow roles" help="Lets a step of a project's own flow use the browser." tag={g.at("flow")}
          control={<Chips items={flowItems.map((r) => ({ id: `${r.root}::${r.id}`, title: `${r.project} · ${r.title}` }))}
            on={(key) => { const r = flowItems.find((x) => `${x.root}::${x.id}` === key); return r ? flowOn(r) : false; }} label="Flow roles" disabled={off} onFlip={flipFlow} />} />
      )}
      {tokenless && (
        <SettingRow kind="control" agentExempt label="No token on this server" control={null}
          help="Set AGENTGLASS_TOKEN so this list can be enforced." />
      )}
      <SettingRow kind="control" agentExempt label="The floor" control={null}
        help="The relay gives a worker only its own container, never yours." />
      {loadFailed && (
        <SettingRow kind="control" label="Could not load who may drive the browser" help="The list did not load, so these switches may be out of date."
          control={<Button onClick={load}>Retry</Button>} agentExempt />
      )}
      <Problem text={err} />
    </>
  );
}

/** One allow list, committed on blur or Enter; a variable set by the environment locks it. */
function AllowList({ settingId, label, help, placeholder }: { settingId: "browser.origins.allow" | "browser.profiles.allow"; label: string; help: string; placeholder: string }) {
  const [text, setText] = useState("");
  const [env, setEnv] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [answered, setAnswered] = useState(false);
  usePageLoading(`allow/${settingId}`, !answered);
  useEffect(() => {
    let live = true;
    void api.settingAtGlobal(settingId).then((r) => { if (!live || !r.ok) return; const t = Array.isArray(r.value) ? (r.value as string[]).join(", ") : "*"; setText(t); setSaved(t); setEnv(r.env?.name ?? null); }).catch(() => undefined)
      .finally(() => { if (live) setAnswered(true); });
    return () => { live = false; };
  }, [settingId]);
  const commit = async () => {
    if (text === saved) return;
    const list = text.split(",").map((x) => x.trim()).filter(Boolean);
    const r: WriteResult = await api.settingsDoorSet(settingId, list.length ? list : ["*"]).catch(() => NO_SERVER);
    if (!r.ok || r.applied === false) { setErr(!r.ok ? r.error || "Could not save it" : WAITS); return; }
    setErr(null); setSaved(text);
  };
  const field = (
    <input value={text} disabled={!!env} spellCheck={false} aria-label={label} placeholder={placeholder}
      onChange={(e) => setText(e.target.value)} onBlur={() => void commit()}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } if (e.key === "Escape") setText(saved); }}
      className={`w-[240px] t-mono ${INPUT}`} />
  );
  return (
    <>
      {env
        ? <SettingRow kind="locked" settingId={settingId} label={label} help={help} reason="Set by the environment" control={field} />
        : <SettingRow kind="control" settingId={settingId} label={label} help={help} control={field} />}
      <Problem text={err} />
    </>
  );
}

/** Which verbs a worker's browser credential may run. */
function WorkerVerbs() {
  const [groups, setGroups] = useState<string[] | null>(null);
  const gate = useLoosenGate();
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { void api.settingAtGlobal("browser.workerVerbs").then((r) => { if (r.ok && Array.isArray(r.value)) setGroups(r.value as string[]); }).catch(() => undefined); }, []);
  useEffect(() => { load(); }, [load]);
  usePageLoading("browser/verbs", groups === null);
  const flip = (g: string) => {
    if (!groups) return;
    const next = groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g];
    const say = (from: string[], to: string[]) => { const opened = addedGrants(from, to); return opened.length ? `use ${sayList(opened.map((x) => WORKER_VERB_GROUPS[x as keyof typeof WORKER_VERB_GROUPS]?.title ?? x))} in the browser` : null; };
    const put = (v: string[]) => {
      void api.settingsDoorSet("browser.workerVerbs", v).catch(() => NO_SERVER).then((r: WriteResult) => { setErr(!r.ok ? r.error || "Could not save it" : r.applied === false ? WAITS : null); load(); });
    };
    // Undo puts the old verbs back; reopening one that was closed asks like any grant.
    gate.gate("verbs", say(groups, next), () => instantSave(groups, next, (v) => (v === next ? put(v) : gate.gate("verbs", say(next, v), () => put(v)))));
  };
  return (
    <>
      <SettingRow kind="control" settingId="browser.workerVerbs" label="Worker verbs" help="Chooses what a worker's browser may do: read, act, DevTools, cookies, eval." tag={gate.at("verbs")}
        control={<Chips items={Object.entries(WORKER_VERB_GROUPS).map(([id, g]) => ({ id, title: g.title }))} on={(g) => groups?.includes(g) ?? false} label="Worker verbs" disabled={!groups} onFlip={flip} />} />
      <Problem text={err} />
    </>
  );
}

/** Guide grants: one agent may guide the person on their own tab, on one site, for two hours. */
function GuideGrants() {
  const [rows, setRows] = useState<GuideGrantRow[] | null>(null);
  const [agent, setAgent] = useState("");
  const [site, setSite] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const take = (r: GuideGrantsReply) => { if (r.ok) { setRows(r.grants ?? []); setErr(null); } else setErr(r.error || "Could not save it"); return r.ok; };
  const load = useCallback(() => { void api.guideGrants().then(take).catch(() => setErr(NO_SERVER.error ?? null)); }, []);
  useEffect(() => { load(); }, [load]);
  const add = () => {
    if (!agent.trim() || !site.trim()) return;
    void api.addGuideGrant(agent.trim(), site.trim()).then((r) => { if (take(r)) { setAgent(""); setSite(""); } }).catch(() => setErr(NO_SERVER.error ?? null));
  };
  const drop = (id: string) => { void api.dropGuideGrant(id).then(take).catch(() => setErr(NO_SERVER.error ?? null)); };
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  const grantFields = (
    <span className="flex items-center gap-2">
          <input value={agent} spellCheck={false} aria-label="Agent" placeholder="agent name" onChange={(e) => setAgent(e.target.value)} onKeyDown={onEnter} className={`w-[140px] t-mono ${INPUT}`} />
          <input value={site} spellCheck={false} aria-label="Site" className={`w-[200px] t-mono ${INPUT}`} placeholder="https://example.com" onChange={(e) => setSite(e.target.value)} onKeyDown={onEnter} />
          <Button onClick={add} disabled={!agent.trim() || !site.trim()}>Add</Button>
        </span>
  );
  return (
    <>
      <SettingRow kind="control" label="Guide grants" help="One agent points, never clicks, on your tab at one site for 2 hours."
        control={grantFields} />
      {(rows ?? []).map((g) => (
        <SettingRow key={g.id} kind="control" label={`${g.agent} · ${g.site}`} help={`Since ${hhmm(g.since)}, ends ${hhmm(g.until)} or when the agent's session ends.`}
          control={<Button onClick={() => drop(g.id)}>Remove</Button>} />
      ))}
      <Problem text={err} />
    </>
  );
}

/** The Gate: ask before anything leaves this machine, who answers, what happens on a timeout. */
function Gate({ open }: { open: boolean }) {
  const [st, setSt] = useState<HookSetupStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { d, set } = useAgentDefaults(open);
  useEffect(() => { if (open) void api.hooksStatus().then(setSt).catch(() => setErr("Could not reach the server.")); }, [open]);
  usePageLoading("hooks/status", open && !st && !err);
  const flip = (on: boolean) => {
    const write = async (v: boolean) => {
      const r = await api.hooksGate(v).catch(() => ({ ok: false, changed: false, error: "Could not reach the server" }));
      if (!r.ok) { setErr(r.error || "Could not update the gate"); return; }
      setErr(null); setSt((cur) => (cur ? { ...cur, gate: v } : cur));
    };
    if (st) instantSave(!on, on, (v) => void write(v), { message: on ? "Saved · start a new session for it to take effect" : "Saved" });
  };
  return (
    <>
      {st && (st.gateBundled
        ? <SettingRow kind="control" settingId="hooks.gate" label="Ask me before anything leaves this machine" help="Makes a push, a pull request or a message wait for your answer."
            control={<Sw on={st.gate} label="Ask me before anything leaves this machine" onFlip={() => flip(!st.gate)} />} />
        : <SettingRow kind="locked" label="Ask me before anything leaves this machine" help="Makes a push, a pull request or a message wait for your answer." reason="Not in this build"
            control={<Switch on={false} />} />)}
      {d && (
        <>
          <SettingRow kind="control" settingId="gate.answerer" label="Who answers" help="Chooses who sees a waiting action first."
            control={<Select value={d.gateAnswerer} align="right" options={GATE_ANSWERERS.map((v) => ({ value: v, label: GATE_ANSWERER_LABEL[v] }))}
              onChange={(v) => void set("gateAnswerer", v as AgentDefaults["gateAnswerer"])} />} />
          <SettingRow kind="control" settingId="gate.onTimeout" label="If nobody answers" help="Decides whether a waiting action asks again or is dropped."
            control={<Segmented track label="If nobody answers" value={d.gateOnTimeout} options={GATE_ON_TIMEOUT.map((v) => ({ id: v, label: GATE_ON_TIMEOUT_LABEL[v] }))}
              onChange={(v) => void set("gateOnTimeout", v as AgentDefaults["gateOnTimeout"])} />} />
        </>
      )}
      <Problem text={err} />
    </>
  );
}

const WRITE_KINDS: { kind: keyof JiraStatus["writeKinds"]; label: string; help: string }[] = [
  { kind: "move", label: "Move cards between steps", help: "Lets a step or hand-off move a card to your status." },
  { kind: "comment", label: "Comment on a card", help: "Lets agentglass post, edit and delete your comments." },
  { kind: "link", label: "Link a pull request to its card", help: "Adds the pull request as a link on the card." },
  { kind: "assign", label: "Assign a person", help: "Lets a step put a person on a card or take them off." },
];

/** Jira writes: the master switch, then the four kinds. */
function JiraWrites({ onOpenJira }: { onOpenJira: () => void }) {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const settings = useJiraSettings();
  useEffect(() => { void api.jiraStatus().then(setStatus).catch(() => setErr("Could not read Jira's state.")); }, []);
  usePageLoading("jira/status", !status && !err);
  if (!status) return <Problem text={err ?? "Reading Jira…"} />;
  if (!status.connected) return <SettingRow kind="link" label="Connect Jira" help="Nothing can change in Jira until it is connected." onOpen={onOpenJira} linkText="Open Jira" />;
  const on = settings ? settings.writes : status.writes;
  const setWrites = async (v: boolean) => {
    const r = await api.jiraWrites(v).catch(() => null);
    if (!r?.ok) { setErr(r?.error ?? "That did not save"); return; }
    setErr(null); setStatus({ ...status, writes: !!r.writes });
    if (settings) noteJiraSettings({ ...settings, writes: !!r.writes });
  };
  const setKind = async (kind: keyof JiraStatus["writeKinds"], v: boolean) => {
    const r = await api.jiraWriteKind(kind, v).catch(() => null);
    if (!r?.ok || !r.writeKinds) { setErr(r?.error ?? "That did not save"); return; }
    setErr(null); setStatus({ ...status, writeKinds: r.writeKinds });
  };
  return (
    <>
      <SettingRow kind="control" settingId="jira.writes" label="Changes in Jira" help="Lets configured steps change a card when you press their button."
        control={<Sw on={on} label="Changes in Jira" onFlip={() => instantSave(on, !on, (v) => void setWrites(v))} />} />
      {WRITE_KINDS.map((w) => {
        const v = status.writeKinds[w.kind];
        return on
          ? <SettingRow key={w.kind} kind="control" settingId={`jira.writes.${w.kind}`} label={w.label} help={w.help} control={<Sw on={v} label={w.label} onFlip={() => instantSave(v, !v, (x) => void setKind(w.kind, x))} />} />
          : <SettingRow key={w.kind} kind="locked" settingId={`jira.writes.${w.kind}`} label={w.label} help={w.help} reason="Turn on Changes in Jira first" control={<Switch on={v} />} />;
      })}
      <Problem text={err} />
    </>
  );
}

/** ClickUp writes: its one master switch. */
function ClickUpWrites() {
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void clickupSetup().then((s) => setOn(s.writeEnabled ?? false)).catch(() => undefined); }, []);
  usePageLoading("clickup/writes", on === null);
  const write = async (v: boolean) => {
    const r = await api.clickupSetWrites(v).catch(() => null);
    __forgetClickupSetup();
    const s = await clickupSetup().catch(() => null);
    if (!s) { setErr("Could not read ClickUp's state."); return; }
    setErr(null); setOn(s.writeEnabled ?? (r ? v : !v));
  };
  return (
    <>
      <SettingRow kind="control" settingId="clickup.writes" label="Changes in ClickUp" help="Lets configured steps change a task when you press their button."
        control={<Sw on={!!on} label="Changes in ClickUp" disabled={on === null} onFlip={() => on !== null && instantSave(on, !on, (v) => void write(v))} />} />
      <Problem text={err} />
    </>
  );
}

/** The Main agent trust and flow switches, then the link to the agent rules. */
function MainAgent({ root, choice, c }: { root: string; choice: ScopeChoice; c: PageCtx }) {
  return (
    <>
      <DoorSwitchRow id="agents.changeWithoutAsking" root={root} choice={choice} label="Let my agents change settings without asking"
        help="Lets this project's agents apply risky changes without waiting for you." allows="change settings without asking" />
      {root
        ? <DoorSwitchRow id="flow.agentEdit" root={root} choice={choice} label="Let this project's orchestrator edit its own flow and roster"
            help="Lets the orchestrator add, rename and place roles; Undo stays yours." allows="edit the flow and roster" />
        : <SettingRow kind="locked" label="Let this project's orchestrator edit its own flow and roster" help="Lets the orchestrator add, rename and place roles." reason="Choose one project to set this" control={<Switch on={false} />} />}
      <SettingRow kind="link" label="Open agent rules" help="Sets Allow, Ask or Never for the rules every agent obeys." linkText="Open"
        onOpen={() => { c.onClose(); window.dispatchEvent(new CustomEvent("agx:open-view", { detail: "agents" })); }} />
    </>
  );
}

export function PermissionsPage({ c }: { c: PageCtx }) {
  const sc = useScope();
  const { ledger, summary } = useScopeLedger(sc.choice);
  const root = sc.root;
  const showBrowser = () => { c.onClose(); window.dispatchEvent(new CustomEvent("agx:open-view", { detail: "browser" })); };
  // Everything below that is not a per-project row is a machine value: one lock, one reason.
  const machine = (node: ReactNode) => <MachineLock choice={sc.choice} onAll={() => sc.setChoice("all")}>{node}</MachineLock>;
  return (
    <ScopeLedgerProvider ledger={ledger}>
    <SettingsPage title="Permissions" purpose="Decide what your agents, their workers and the browser may do, and what may leave this machine."
      scopeSlot={<div className="flex flex-col gap-1.5"><ScopeControl {...sc.controlProps} />{summary}</div>}
      scopeKey={root}
      sections={[
        { id: "main", title: "Main agent", kind: "normal", body: <Section id="main" title="Main agent" intro="Trust and flow for the agent you talk to."><MainAgent root={root} choice={sc.choice} c={c} /></Section> },
        { id: "launch", title: "Launch permissions", kind: "normal", body: <Section id="launch" title="Launch permissions" intro="What an agent may do when a terminal starts it.">{machine(<LaunchPermissions open={c.open} />)}</Section> },
        { id: "workers", title: "Worker commands", kind: "normal", body: <Section id="workers" title="Worker commands" intro="Open by default. Sudo and git worktree lock, move, repair and unlock stay refused."><WorkerCommands root={root} choice={sc.choice} /></Section> },
        { id: "level", title: "Worker level and limits", kind: "normal", body: (
          <Section id="level" title="Worker level and limits" intro="What a worker may write, commit, reach and run, and what is always refused.">
            <WorkerLevel root={root} open={c.open} />
          </Section>) },
        { id: "outside", title: "Changes outside", kind: "normal", body: (
          <Section id="outside" title="Changes outside" intro="What may leave this machine, and what may change in Jira and ClickUp.">
            {machine(<>
              <Gate open={c.open} />
              <JiraWrites onOpenJira={() => c.setPane("jira")} />
              <ClickUpWrites />
            </>)}
          </Section>) },
        { id: "browser", title: "Who may drive the browser", kind: "normal", body: (
          <Section id="browser" title="Who may drive the browser" intro="A worker drives it in its own container; yours is never reachable.">
            {machine(<>
              <BrowserDrivers open={c.open} />
              <SettingRow kind="link" label="Widening waits for you" help="Turning one back on is a request that waits for you." linkText="Show it" onOpen={showBrowser} />
            </>)}
          </Section>) },
        { id: "reach", title: "What a worker's browser may reach", kind: "normal", body: (
          <Section id="reach" title="What a worker's browser may reach" intro="Starts as it shipped: every origin and profile, read and act verbs.">
            {machine(<>
              <AllowList settingId="browser.origins.allow" label="Allowed origins" help="Lists the hosts a worker may open; * is every origin." placeholder="*, localhost:8001, example.com" />
              <AllowList settingId="browser.profiles.allow" label="Allowed profiles" help="Lists the named profiles a worker may use; * is every profile." placeholder="*, support" />
              <WorkerVerbs />
              <GuideGrants />
            </>)}
          </Section>) },
        { id: "check", title: "Test a command", kind: "normal", body: <Section id="check" title="Test a command" intro="Ask the server what a new worker would get."><CheckCommand project={sc.project} /></Section> },
      ]}
    />
    </ScopeLedgerProvider>
  );
}
