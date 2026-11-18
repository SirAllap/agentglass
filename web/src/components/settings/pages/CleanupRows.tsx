import { useEffect, useRef, useState } from "react";
import { openProjectPicker } from "../../../lib/openSettings.ts";
import { api } from "../../../lib/api.ts";
import {
  CLEANUP_KIND_ROWS, type CleanupKind, briefsOf, checkBriefsDir, checkTeardownScript, checkTemplateText, includeOf, leftoverFieldsOf,
  listOfText, readPick, saveLine, teardownOf, withBriefsDir, withKind, withLeftovers, withTeardownScript,
} from "../../../lib/cleanupSettings.ts";
import { Switch } from "../../orchestration/flow/Switch.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TextCommitField, instantSave } from "../save/index.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { GIT_ROWS } from "./pageRows.ts";

const COPY = Object.fromEntries(GIT_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });
// The section says it once (NoProjectNote); a row under it stays readable and disabled, with no reason line of its own.
const NO_PROJECT = "";
/** The id of NoProjectNote: the locked rows under it point at it. */
export const NO_PROJECT_ID = "cleanup-no-project";

/** The project in view and a writer for one of its cleanup settings; `false` from `write` means it did not save. */
function useCleanupProject() {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.projects().then((r) => {
      const at = readPick(r.workspaces ?? (r.workspace ? [r.workspace] : []));
      if (live && at) setRoot(at);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  // One write at a time: two quick edits would otherwise read the same config and the later write would lose the earlier field.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const queued = <T,>(job: () => Promise<T>): Promise<T> => {
    const done = chain.current.then(job, job);
    chain.current = done.catch(() => undefined);
    return done;
  };
  const put = async (id: string, value: unknown) => {
    if (!root) return false;
    return saveLine(await api.settingAtSet(id, value, root).catch(() => null)).phase !== "error";
  };
  const write = (id: string, value: unknown) => queued(() => put(id, value));
  /** `cleanup.config` is one object the door replaces whole: read it fresh, change one field, write it back. */
  const patchConfig = (change: (cur: unknown) => Record<string, unknown>) => queued(async () => {
    if (!root) return false;
    const cur = await api.settingAt("cleanup.config", root).catch(() => null);
    return cur?.ok ? put("cleanup.config", change(cur.value)) : false;
  });
  const read = async (id: string) => (root ? api.settingAt(id, root).catch(() => null) : null);
  return { root, write, patchConfig, read };
}

/** Which leftovers a cleanup plan holds: one switch per kind, each saved as it is touched. */
export function CleanupInclude() {
  const p = useCleanupProject();
  const [kinds, setKinds] = useState<CleanupKind[]>(() => includeOf(null));
  useEffect(() => {
    let live = true;
    void p.read("cleanup.include").then((v) => { if (live && v?.ok) setKinds(includeOf(v.value)); });
    return () => { live = false; };
  }, [p.root]);
  const flip = (k: CleanupKind, on: boolean) => {
    const was = kinds;
    instantSave(was, withKind(was, k, on), (next) => { setKinds(next); void p.write("cleanup.include", next).then((ok) => { if (!ok) setKinds((cur) => withKind(cur, k, !on)); }); });
  };
  return (
    <div className="contents">
      {/* The one indexed row for cleanup.include: search and the agent audit find the setting here; the kinds below are its parts. */}
      <SettingRow kind="control" settingId="cleanup.include" label={COPY["cleanup.include"].label} help={COPY["cleanup.include"].help} control={null} />
      {CLEANUP_KIND_ROWS.map((k) => (
        <SettingRow key={k.id} kind={p.root ? "control" : "locked"} reason={NO_PROJECT} describedBy={NO_PROJECT_ID} agentExempt label={k.name} help={k.text}
          control={<Switch on={kinds.includes(k.id)} label={k.name} disabled={!p.root} onChange={(on) => flip(k.id, on)} />} />
      ))}
    </div>
  );
}

/** The one note for a section whose rows need a project: said once, with the same picker the header opens. */
export function NoProjectNote() {
  const { root } = useCleanupProject();
  if (root) return null;
  return (
    <div id={NO_PROJECT_ID} data-row-reason className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium" style={{ color: "var(--text2)" }}>
      <span>Open a project to set these.</span>
      <button type="button" className="underline" style={{ color: "var(--accent)" }} onClick={openProjectPicker}>Open a project</button>
    </div>
  );
}

/** The briefs folder, the teardown script and the Docker leftovers: the three parts of `cleanup.config`, one text field each. */
export function CleanupConfigRows() {
  const p = useCleanupProject();
  const [v, setV] = useState({ briefs: "", teardown: "", template: "", patterns: "", keep: "" });
  useEffect(() => {
    let live = true;
    void p.read("cleanup.config").then((c) => {
      if (!live || !c?.ok) return;
      const f = leftoverFieldsOf(c.value);
      setV({ briefs: briefsOf(c.value), teardown: teardownOf(c.value), template: f.template, patterns: f.patterns.join(", "), keep: f.keep.join(", ") });
    });
    return () => { live = false; };
  }, [p.root]);
  const lock = { kind: p.root ? "control" : "locked", reason: NO_PROJECT } as const;
  const leftovers = (change: Partial<{ template: string; patterns: string[]; keep: string[] }>) =>
    p.patchConfig((cur) => withLeftovers(cur, { ...leftoverFieldsOf(cur), ...change }));
  return (
    <div className="contents" data-setting="cleanup.config">
      <SettingRow kind={lock.kind} reason={lock.reason} {...row("cleanup.config.briefsDir")}
        control={<TextCommitField label="Briefs folder" mono placeholder="docs/briefs" value={v.briefs}
          validate={(t) => { const r = checkBriefsDir(t); return r.ok ? null : r.why; }}
          onSave={(t) => { const r = checkBriefsDir(t); if (r.ok) void p.patchConfig((c) => withBriefsDir(c, r.dir)).then((ok) => ok && setV((s) => ({ ...s, briefs: r.dir }))); }} />} />
      <SettingRow kind={lock.kind} reason={lock.reason} {...row("cleanup.config.teardownScript")}
        control={<TextCommitField label="Teardown script" mono placeholder="scripts/teardown.sh" value={v.teardown}
          validate={(t) => { const r = checkTeardownScript(t); return r.ok ? null : r.why; }}
          onSave={(t) => { const r = checkTeardownScript(t); if (r.ok) void p.patchConfig((c) => withTeardownScript(c, r.path)).then((ok) => ok && setV((s) => ({ ...s, teardown: r.path }))); }} />} />
      <SettingRow kind={lock.kind} reason={lock.reason} {...row("cleanup.config.dockerImage")}
        control={<TextCommitField label="Image tag template" mono placeholder="app:{sha}" value={v.template}
          validate={(t) => checkTemplateText(t.trim())}
          onSave={(t) => { void leftovers({ template: t.trim() }).then((ok) => ok && setV((s) => ({ ...s, template: t.trim() }))); }} />} />
      <SettingRow kind={lock.kind} reason={lock.reason} {...row("cleanup.config.dockerVolumes")}
        control={<TextCommitField label="Orphan volume patterns" mono placeholder="app-cache-{slug}" value={v.patterns}
          onSave={(t) => { void leftovers({ patterns: listOfText(t) }).then((ok) => ok && setV((s) => ({ ...s, patterns: listOfText(t).join(", ") }))); }} />} />
      <SettingRow kind={lock.kind} reason={lock.reason} {...row("cleanup.config.dockerKeep")}
        control={<TextCommitField label="Volumes never listed" mono placeholder="psql-*" value={v.keep}
          onSave={(t) => { void leftovers({ keep: listOfText(t) }).then((ok) => ok && setV((s) => ({ ...s, keep: listOfText(t).join(", ") }))); }} />} />
    </div>
  );
}
