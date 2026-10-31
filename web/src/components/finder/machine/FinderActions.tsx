// Settings -> Actions: the person's own scripts for the file and folder menus, as
// Strata's page draws them (heading, the warning that they run with the person's
// permissions, "New action…", a row per action with switch / edit / duplicate /
// delete, and the ones that could not load listed as problems). The editor has
// Strata's three tabs: General, Script, Behavior. What an action may be and whether
// it runs is the server's (server/src/finderactions.ts); this only asks.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { blankAction, formOf, fromForm, listText, slugify, whenSummary, type ActionForm } from "../../../lib/finderActions.ts";
import type { FinderAction } from "../../../../../shared/types.ts";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { Field } from "../../SettingsKit.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
import { ConfirmDialog } from "./FinderOpsUI.tsx";

const ICONS = ["play", "terminal", "image", "file-archive", "file-code", "copy", "folder", "download", "globe", "package-plus", "scale", "sliders-horizontal"] as const;
const SCRIPT_STARTER = { python: '# Python 3. The selection is in sys.argv[1:], after "--".\nimport sys\nprint(sys.argv[1:])\n', bash: '#!/usr/bin/env bash\n# The selection is "$@", after "--".\nprintf \'%s\\n\' "$@"\n' } as const;

const btn = "agx-btn rounded-md px-3";
const bstyle = { minHeight: HIT, border: EDGE } as const;

function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="agx-btn shrink-0 relative rounded-full" style={{ width: 38, height: 22, border: EDGE, background: on ? "var(--primary)" : "transparent" }}>
      <span className="absolute rounded-full" style={{ top: 2, left: on ? 18 : 2, width: 16, height: 16, background: on ? "var(--bg)" : "var(--text3)", transition: "left 120ms" }} />
    </button>
  );
}

type Tab = "general" | "script" | "behavior";

function Editor({ start, create, onClose, onSaved }: { start: FinderAction; create: boolean; onClose: () => void; onSaved: (said: string) => void }) {
  const [a, setA] = useState<FinderAction>(start);
  const [form, setForm] = useState<ActionForm>(() => formOf(start));
  const [script, setScript] = useState<string>(start.script ?? (start.run.runtime === "bash" ? SCRIPT_STARTER.bash : SCRIPT_STARTER.python));
  const [tab, setTab] = useState<Tab>("general");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<FinderAction>) => setA((x) => ({ ...x, ...p }));
  const run = (p: Partial<FinderAction["run"]>) => setA((x) => ({ ...x, run: { ...x.run, ...p } }));
  const id = create ? (form.id || slugify(a.name)) : a.id;
  const save = async () => {
    setBusy(true); setErr(null);
    const m = fromForm({ ...a, id }, { ...form, id });
    const r = await api.actionSave(m, m.run.runtime === "command" ? undefined : script, create);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "That did not save"); return; }
    onSaved(create ? `${m.name} added` : `${m.name} saved`);
  };
  return (
    <div role="dialog" aria-label={create ? "New action" : `Edit ${a.name}`} className="rounded-lg mb-4" style={{ border: EDGE, background: "var(--surface-card)" }}>
      <div className="flex items-center gap-2 px-3" style={{ minHeight: 44, borderBottom: LINE }}>
        <b className="flex-1 text-[13px] truncate">{create ? "New action" : a.name || "Edit action"}</b>
        <button className="agx-btn rounded-md grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="Close editor" onClick={onClose}><StrataIcon set="act" name="x" size={ICON.sm} /></button>
      </div>
      <div role="tablist" className="flex gap-1 px-3 pt-2">
        {(["general", "script", "behavior"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="agx-btn rounded-md px-3 capitalize" style={{ minHeight: HIT - 6, background: tab === t ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined }}>{t}</button>
        ))}
      </div>
      <div className="p-3">
        {tab === "general" && (
          <>
            <Field label="Name" htmlFor="fa-name"><input id="fa-name" className={`${INPUT} w-full`} style={INPUT_STYLE} value={a.name} maxLength={64} spellCheck={false} onChange={(e) => set({ name: e.target.value })} placeholder="Resize image" /></Field>
            <Field label="Description" htmlFor="fa-description"><input id="fa-description" className={`${INPUT} w-full`} style={INPUT_STYLE} value={a.description} maxLength={300} onChange={(e) => set({ description: e.target.value })} /></Field>
            <Field label="Icon" htmlFor="fa-icon">
              <span role="group" aria-label="Icon" className="flex flex-wrap gap-1.5 mt-1">
                {ICONS.map((n) => (
                  <button key={n} id={n === ICONS[0] ? "fa-icon" : undefined} aria-label={n} aria-pressed={a.icon === n} onClick={() => set({ icon: n })} className="agx-btn rounded-md grid place-items-center" style={{ width: HIT, height: HIT, border: EDGE, color: "var(--primary-ink)", background: a.icon === n ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined }}><StrataIcon set="act" name={n} size={ICON.sm} /></button>
                ))}
              </span>
            </Field>
            <div className="flex items-center gap-3 mb-1"><Switch on={a.enabled} label="Enabled" onClick={() => set({ enabled: !a.enabled })} /><span>Enabled</span></div>
            <Field label="Where it appears" htmlFor="fa-where-it-appears" hint="Under one Actions entry, or directly in the menu.">
              <select id="fa-where-it-appears" className={INPUT} style={INPUT_STYLE} value={a.menu} onChange={(e) => set({ menu: e.target.value as "submenu" | "top" })}><option value="submenu">In the Actions submenu</option><option value="top">At the top of the menu</option></select>
            </Field>
            {create && <Field label="Id" htmlFor="fa-id" hint="Names its folder. Lowercase letters, digits, dots, dashes."><input id="fa-id" className={`${INPUT} w-full`} style={INPUT_STYLE} value={form.id || slugify(a.name)} spellCheck={false} onChange={(e) => setForm({ ...form, id: e.target.value })} /></Field>}
          </>
        )}
        {tab === "script" && (
          <>
            <Field label="Runs with" htmlFor="fa-runs-with">
              <select id="fa-runs-with" className={INPUT} style={INPUT_STYLE} value={a.run.runtime} onChange={(e) => {
                const rt = e.target.value as FinderAction["run"]["runtime"];
                run({ runtime: rt, entrypoint: rt === "bash" ? "action.sh" : "action.py" });
                if (rt !== "command" && (script === SCRIPT_STARTER.python || script === SCRIPT_STARTER.bash)) setScript(SCRIPT_STARTER[rt]);
              }}><option value="python">Python 3 script</option><option value="bash">Bash script</option><option value="command">A program</option></select>
            </Field>
            {a.run.runtime === "command" ? (
              <>
                <Field label="Program" htmlFor="fa-program" hint="Found on PATH, or an absolute path."><input id="fa-program" className={`${INPUT} w-full`} style={INPUT_STYLE} value={a.run.program} spellCheck={false} onChange={(e) => run({ program: e.target.value })} placeholder="sha256sum" /></Field>
                <Field label="Arguments" htmlFor="fa-arguments" hint="One per line. {path}, {paths} and {parent} stand for the selection. With none, the selection follows after --."><textarea id="fa-arguments" className={`${INPUT} w-full`} style={{ ...INPUT_STYLE, minHeight: 80 }} value={a.run.args.join("\n")} spellCheck={false} onChange={(e) => run({ args: e.target.value.split("\n").filter((x) => x !== "") })} /></Field>
              </>
            ) : (
              <Field label="Script" htmlFor="fa-script" hint="Runs as your user. The selection arrives as arguments after --, never through a shell line."><textarea id="fa-script" className={`${INPUT} w-full font-mono`} style={{ ...INPUT_STYLE, minHeight: 200 }} value={script} spellCheck={false} onChange={(e) => setScript(e.target.value)} /></Field>
            )}
          </>
        )}
        {tab === "behavior" && (
          <>
            <Field label="Shows for" htmlFor="fa-shows-for">
              <select id="fa-shows-for" className={INPUT} style={INPUT_STYLE} value={form.kinds} onChange={(e) => setForm({ ...form, kinds: e.target.value as ActionForm["kinds"] })}><option value="both">Files and folders</option><option value="file">Files only</option><option value="folder">Folders only</option></select>
            </Field>
            <Field label="File extensions" htmlFor="fa-file-extensions" hint="Separated by commas; none means any."><input id="fa-file-extensions" className={`${INPUT} w-full`} style={INPUT_STYLE} value={form.extensions} spellCheck={false} onChange={(e) => setForm({ ...form, extensions: e.target.value })} placeholder="png, jpg" /></Field>
            <Field label="File types" htmlFor="fa-file-types" hint="Like image/* or application/pdf."><input id="fa-file-types" className={`${INPUT} w-full`} style={INPUT_STYLE} value={form.mime} spellCheck={false} onChange={(e) => setForm({ ...form, mime: e.target.value })} /></Field>
            <div className="flex gap-3">
              <Field label="At least" htmlFor="fa-at-least"><input id="fa-at-least" type="number" min={0} className={`${INPUT} w-24`} style={INPUT_STYLE} value={a.when.min_items} onChange={(e) => setA({ ...a, when: { ...a.when, min_items: Math.max(0, Number(e.target.value) || 0) } })} /></Field>
              <Field label="At most" htmlFor="fa-at-most"><input id="fa-at-most" type="number" min={0} className={`${INPUT} w-24`} style={INPUT_STYLE} value={form.maxItems} onChange={(e) => setForm({ ...form, maxItems: e.target.value })} placeholder="any" /></Field>
            </div>
            <Field label="Selection" htmlFor="fa-selection">
              <select id="fa-selection" className={INPUT} style={INPUT_STYLE} value={a.run.mode} onChange={(e) => run({ mode: e.target.value as "whole-selection" | "per-item" })}><option value="whole-selection">Run once on the whole selection</option><option value="per-item">Run once per item</option></select>
            </Field>
            <Field label="If one fails" htmlFor="fa-if-one-fails">
              <select id="fa-if-one-fails" className={INPUT} style={INPUT_STYLE} value={a.run.on_error} onChange={(e) => run({ on_error: e.target.value as "continue" | "stop" })}><option value="continue">Keep going</option><option value="stop">Stop</option></select>
            </Field>
            <Field label="Working folder" htmlFor="fa-working-folder">
              <select id="fa-working-folder" className={INPUT} style={INPUT_STYLE} value={a.run.working_directory} onChange={(e) => run({ working_directory: e.target.value as "parent" | "home" | "action" })}><option value="parent">The folder of the selection</option><option value="home">Home</option><option value="action">The action's own folder</option></select>
            </Field>
            <div className="flex items-center gap-3"><Switch on={a.run.confirm} label="Ask before running" onClick={() => run({ confirm: !a.run.confirm })} /><span>Ask before running</span></div>
          </>
        )}
        {err && <p role="alert" className="mt-3 mb-0" style={{ color: "var(--error-ink)" }}>{err}</p>}
      </div>
      <div className="flex justify-end gap-2 px-3 py-2" style={{ borderTop: LINE }}>
        <button className={btn} style={bstyle} onClick={onClose}>Cancel</button>
        <button className={btn} style={{ ...bstyle, borderColor: "var(--primary)", color: "var(--primary-ink)" }} disabled={busy || !a.name.trim()} onClick={() => { void save(); }}>Save</button>
      </div>
    </div>
  );
}

export function ActionsManager({ narrow, say }: { narrow: boolean; say: (s: string) => void }) {
  const [list, setList] = useState<{ actions: FinderAction[]; problems: { id: string; error: string }[] } | null>(null);
  const [editing, setEditing] = useState<{ a: FinderAction; create: boolean } | null>(null);
  const [del, setDel] = useState<FinderAction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { void api.actionsList().then((r) => { if (!r.ok) setErr(r.error ?? "The actions could not be listed"); else { setErr(null); setList({ actions: r.actions, problems: r.problems }); } }); }, []);
  useEffect(load, [load]);
  const fail = (m?: string) => say(m ?? "That did not work");
  const flip = (a: FinderAction) => { void api.actionSave({ ...a, enabled: !a.enabled }, undefined, false).then((r) => { if (r.ok) load(); else fail(r.error); }); };
  const edit = (a: FinderAction) => { void api.actionRead(a.id).then((r) => { if (r.ok && r.action) setEditing({ a: r.action, create: false }); else fail(r.error); }); };
  const copy = (a: FinderAction) => {
    void api.actionRead(a.id).then(async (r) => {
      if (!r.ok || !r.action) { fail(r.error); return; }
      const taken = new Set(list?.actions.map((x) => x.id));
      let id = `${a.id}-copy`.slice(0, 60); for (let n = 2; taken.has(id); n++) id = `${a.id}-copy-${n}`.slice(0, 64);
      const w = await api.actionSave({ ...r.action, id, name: `${a.name} copy`.slice(0, 64) }, r.action.script, true);
      if (w.ok) { load(); say(`${a.name} duplicated`); } else fail(w.error);
    });
  };
  return (
    <div>
      <div className={`flex mb-3 ${narrow ? "" : "justify-end"}`}>
        <button className={btn} style={bstyle} onClick={() => setEditing({ a: blankAction(), create: true })}>New action…</button>
      </div>
      {editing && <Editor key={editing.a.id || "new"} start={editing.a} create={editing.create} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); load(); say(m); }} />}
      {err && <p role="alert" style={{ color: "var(--error-ink)" }}>{err}</p>}
      {list && list.actions.length === 0 && list.problems.length === 0 && (
        <div className="rounded-md px-3 py-3" style={{ border: EDGE, color: "var(--text3)" }}>No custom actions yet. Create one to add it to the context menu.</div>
      )}
      {list?.actions.map((a) => (
        <div key={a.id} className={`flex gap-3 py-2.5 ${narrow ? "flex-wrap items-start" : "items-center"}`} style={{ borderTop: LINE }}>
          <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name={ICONS.includes(a.icon as never) ? a.icon : "play"} size={ICON.sm} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] truncate">{a.name}</div>
            <div className="text-[11px] truncate" style={{ color: a.unavailable ? "var(--error-ink)" : "var(--text3)" }}>{a.unavailable ?? (a.description || whenSummary(a))}</div>
          </div>
          <Switch on={a.enabled} label={`${a.name} enabled`} onClick={() => flip(a)} />
          <button className="agx-btn rounded-md px-2" style={bstyle} onClick={() => edit(a)}>Edit</button>
          <button className="agx-btn rounded-md px-2" style={bstyle} onClick={() => copy(a)}>Duplicate</button>
          <button className="agx-btn rounded-md px-2" style={{ ...bstyle, color: "var(--error-ink)" }} onClick={() => setDel(a)}>Delete</button>
        </div>
      ))}
      {list && list.problems.length > 0 && (
        <section aria-label="Problems" className="mt-4">
          <h4 className="m-0 mb-1 text-[10.5px] uppercase tracking-[0.1em]" style={{ color: "var(--text3)", fontWeight: 600 }}>Problems</h4>
          {list.problems.map((p) => (
            <div key={p.id} className="flex gap-3 py-2 items-center" style={{ borderTop: LINE }}>
              <div className="flex-1 min-w-0"><div className="text-[12.5px] truncate">{p.id}</div><div className="text-[11px]" style={{ color: "var(--error-ink)" }}>{p.error}</div></div>
              <button className="agx-btn rounded-md px-2" style={{ ...bstyle, color: "var(--error-ink)" }} onClick={() => { void api.actionDelete(p.id).then((r) => { if (r.ok) load(); else fail(r.error); }); }}>Remove</button>
            </div>
          ))}
        </section>
      )}
      {del && <ConfirmDialog title={`Delete ${del.name}?`} body="Its folder and script are removed. This cannot be undone." confirm="Delete" onClose={() => setDel(null)} onConfirm={() => { const a = del; setDel(null); void api.actionDelete(a.id).then((r) => { if (r.ok) { load(); say(`${a.name} deleted`); } else fail(r.error); }); }} />}
    </div>
  );
}
