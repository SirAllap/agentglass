/*
 * Where a saved command is written, and where it is run from.
 *
 * One pane for both, deliberately. A recipe is edited about twice and run about
 * a hundred times, and splitting those across two places would mean the thing
 * you do constantly lives behind the thing you almost never do. So the list
 * runs them, and the editor opens underneath the one you are changing.
 *
 * Nothing here composes a command line. The server does that — `recipeRender`
 * answers with the lines that WOULD run, already substituted and quoted — and
 * this pane's job is to show them and then hand them, unchanged, to the same
 * console path a typed command takes. That separation is the whole reason a
 * parameter box is safe to have.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { retryLoad } from "../lib/retryLoad.ts";
import type { Recipe, RecipeParam, GitRepoRef } from "../../../shared/types.ts";
import { consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { CheckoutPicker } from "./CheckoutPicker.tsx";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--border) ${pct}%, transparent)`;
const PARAM_TYPES: RecipeParam["type"][] = ["text", "choice", "flag", "repo", "worktree", "branch"];

const blank = (): Recipe => ({
  id: "", name: "", desc: "", steps: [""], scope: "global", params: [], addedAt: 0,
});

export function RecipesPane({ open }: { open: boolean }) {
  const [list, setList] = useState<Recipe[] | null>(null);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [running, setRunning] = useState<Recipe | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);

  const load = useCallback(async () => {
    try { setList((await api.recipes()).recipes); } catch { setList([]); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
  }, [open, load]);

  const save = async (r: Recipe) => {
    const res = await api.recipeSave(r);
    if (!res.ok) { setNote({ ok: false, text: res.error ?? "That did not save" }); return; }
    setNote({ ok: true, text: `${r.name} saved` });
    setEditing(null);
    await load();
  };
  const drop = async (r: Recipe) => {
    await api.recipeRemove(r.id).catch(() => {});
    setNote({ ok: true, text: `${r.name} removed — nothing else was touched` });
    setEditing(null);
    await load();
  };

  if (!list) return <Wrap><div className="py-3 text-[12.5px]" style={{ color: "var(--text3)" }}>Reading your recipes…</div></Wrap>;

  /* One row per command, on the dialog's grid: the Run and Edit buttons of
     every recipe land on the same two lines, which is the whole reason a list
     of saved things is faster to use than a stack of cards. */
  return (
    <Wrap>
      {note && (
        <div className="my-2 text-[12px] px-2 py-1 rounded"
          style={{ color: note.ok ? "var(--success)" : "var(--error)",
            background: `color-mix(in srgb, var(--${note.ok ? "success" : "error"}) 10%, transparent)` }}>
          {note.text}
        </div>
      )}

      {list.map((r) => (
        <SettingRow key={r.id}
          label={r.name}
          hint={<>
            {r.desc && <span className="block truncate">{r.desc}</span>}
            {r.scope === "global" ? "global" : (r.repo?.split("/").pop() ?? "repo")} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"}
            {r.params?.length ? ` · ${r.params.length} param${r.params.length === 1 ? "" : "s"}` : ""}
            {r.boot ? " · at start" : ""}
          </>}
          control={<span className="flex items-center gap-2">
            <button onClick={() => setRunning(r)} className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }}>Run…</button>
            <button onClick={() => setEditing(r)} className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ border: edge(20), color: "var(--text2)" }}>Edit</button>
          </span>}
        />
      ))}
      {!list.length && (
        <div className="py-2 text-[12.5px]" style={{ color: "var(--text4)" }}>
          Nothing saved yet. The first one is usually a thing you have typed three times this week.
        </div>
      )}

      {!editing && (
        <div className="py-2">
          <button onClick={() => setEditing(blank())} className="text-[12px] px-2.5 py-1 rounded-lg"
            style={{ border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }}>
            ＋ New recipe
          </button>
        </div>
      )}

      {editing && <Editor r={editing} repos={repos} onChange={setEditing} onSave={save} onDrop={drop} onCancel={() => setEditing(null)} />}
      {running && <RunDialog r={running} repos={repos} onClose={() => setRunning(null)} onNote={setNote} />}
    </Wrap>
  );
}

/** The same shape SettingsModal's Section renders — an eyebrow-less rows box —
 *  so the settings column's one padding rule reaches this page. Written out
 *  rather than imported because SettingsModal imports this file. */
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="pb-5 agx-settings-section"><div className="agx-settings-rows">{children}</div></div>;
}

function Editor({ r, repos, onChange, onSave, onDrop, onCancel }: {
  r: Recipe; repos: GitRepoRef[];
  onChange: (r: Recipe) => void; onSave: (r: Recipe) => void; onDrop: (r: Recipe) => void; onCancel: () => void;
}) {
  const set = (patch: Partial<Recipe>) => onChange({ ...r, ...patch });
  /** Boot and the two things that would need asking are mutually exclusive —
   *  the server refuses saving the combination, so the editor says so up
   *  front rather than letting the save be the first to find out. */
  const cannotBoot = !!(r.params?.length) || !!r.confirm;
  const inp = "w-full text-[11.5px] px-2 py-1.5 rounded-lg outline-none";
  const style = { background: "var(--bg2)", border: edge(22), color: "var(--text)" };
  return (
    <div className="rounded-xl p-3 flex flex-col gap-2.5" style={{ border: edge(28), background: "color-mix(in srgb, var(--bg3) 25%, transparent)" }}>
      <div className="flex gap-2 flex-wrap">
        <input value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name — how you will call it"
          className={inp} style={{ ...style, maxWidth: 220 }} />
        <input value={r.desc} onChange={(e) => set({ desc: e.target.value })} placeholder="What it does"
          className={`${inp} flex-1 min-w-[180px]`} style={style} />
      </div>

      {/* One step per line. A textarea rather than a list of rows: these are
          lines of shell, and people write them the way they write shell. */}
      <label className="flex flex-col gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Steps — one per line, {"{{name}}"} for a parameter</span>
        <textarea value={r.steps.join("\n")} onChange={(e) => set({ steps: e.target.value.split("\n") })}
          rows={Math.max(3, r.steps.length + 1)} spellCheck={false}
          className={`${inp} font-mono`} style={{ ...style, resize: "vertical" }} />
      </label>

      <div className="flex gap-2 flex-wrap items-end">
        <label className="flex flex-col gap-1">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Where it applies</span>
          <select value={r.scope} onChange={(e) => set({ scope: e.target.value as Recipe["scope"], repo: e.target.value === "global" ? undefined : (r.repo || repos[0]?.root) })}
            className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}>
            <option value="global">Everywhere</option>
            <option value="repo">One repository</option>
          </select>
        </label>
        {r.scope === "repo" && (
          <label className="flex flex-col gap-1 min-w-[180px]">
            <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Repository</span>
            <select value={r.repo ?? ""} onChange={(e) => set({ repo: e.target.value })}
              className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}>
              {repos.map((x) => <option key={x.root} value={x.root}>{x.name || x.root}</option>)}
            </select>
          </label>
        )}
        {/* The "run inside tmux" box was here, promising "survives closing the
            app". It kept that promise on the MACHINE's tmux, by typing a bare
            `tmux new-session` into the shell. The console runs on the engine
            now and every recipe outlives the app already, so the box had
            nothing left to offer. The stored flag is left alone rather than
            migrated away — an old recipe carrying it is not wrong, it is just
            describing something that is now true of all of them. */}
        <label className="flex items-center gap-1.5 text-[11px] pb-1.5" style={{ color: "var(--text2)" }}>
          <input type="checkbox" checked={!!r.confirm} onChange={(e) => set({ confirm: e.target.checked })}
            disabled={!!r.boot} title={r.boot ? "A command that runs at start fires with nobody to ask" : undefined} />
          Always ask first
        </label>
        {/* A boot recipe runs the moment the app opens, with nobody to fill a
            box or click anything. The server refuses saving one that has
            parameters, asks first, or reads as destructive — these two
            checkboxes just keep the editor from leading somewhere the save
            would refuse. */}
        <label className="flex items-center gap-1.5 text-[11px] pb-1.5" style={{ color: cannotBoot ? "var(--text4)" : "var(--text2)" }}>
          <input type="checkbox" checked={!!r.boot} disabled={cannotBoot}
            title={cannotBoot ? "Remove the parameters or the ask-first to run it at start" : undefined}
            onChange={(e) => set(e.target.checked ? { boot: true, confirm: false } : { boot: false })} />
          Run when the app starts <span style={{ color: "var(--text4)" }}>— in the docked console, on every open</span>
        </label>
      </div>

      {/* Parameters. Kept next to the steps that use them, because the only way
          to get a `{{key}}` right is to see both at once. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Parameters</span>
        {(r.params ?? []).map((p, i) => (
          <div key={i} className="flex gap-1.5 flex-wrap items-center">
            <input value={p.key} onChange={(e) => set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, key: e.target.value } : x) })}
              placeholder="name" className="text-[11px] px-2 py-1 rounded-lg font-mono" style={{ ...style, width: 130 }} />
            <select value={p.type} onChange={(e) => set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, type: e.target.value as RecipeParam["type"] } : x) })}
              className="text-[11px] px-2 py-1 rounded-lg" style={style}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {p.type === "choice" && (
              <input value={(p.options ?? []).join(", ")} onChange={(e) => set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x) })}
                placeholder="one, two, three" className="text-[11px] px-2 py-1 rounded-lg flex-1 min-w-[140px]" style={style} />
            )}
            {p.type === "flag" && (
              <input value={p.value ?? ""} onChange={(e) => set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}
                placeholder="--rebuild-fe" className="text-[11px] px-2 py-1 rounded-lg font-mono flex-1 min-w-[140px]" style={style} />
            )}
            <CloseButton onClick={() => set({ params: (r.params ?? []).filter((_, j) => j !== i) })} style={{ color: "var(--text4)" }} className="rounded" />
          </div>
        ))}
        <button onClick={() => set({ boot: false, params: [...(r.params ?? []), { key: "", label: "", type: "text" }] })}
          className="self-start text-[10.5px] px-2 py-0.5 rounded" style={{ border: edge(20), color: "var(--text3)" }}>＋ parameter</button>
      </div>

      <div className="flex gap-2 flex-wrap pt-1">
        <button onClick={() => onSave(r)} className="text-[11px] px-3 py-1 rounded-lg"
          style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)", color: "var(--text)" }}>Save</button>
        <button onClick={onCancel} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text3)" }}>Cancel</button>
        <span className="flex-1" />
        {r.id && <button onClick={() => onDrop(r)} className="text-[11px] px-2 py-1 rounded-lg"
          style={{ border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)", color: "var(--error)" }}>Delete</button>}
      </div>
    </div>
  );
}

/**
 * Send a recipe's already-resolved lines to the docked console.
 *
 * The console is the one surface the menu, a pinned chip, and Settings can all
 * reach; it is one-per-repo and reused; and — the point — it is a plain shell
 * at startup rather than whatever terminal pane happens to be focused. A focused
 * pane can be sitting inside a tmux an agent is driving, and the full-screen
 * guard waves tmux through (it cannot see the pane's program), so a line meant
 * for a shell lands in the agent's prompt instead. Routing every recipe here is
 * what keeps `tmux attach` from being typed at Claude, and makes the three
 * surfaces behave the same.
 *
 * There is no "run inside tmux" flag any more, and there is nothing left for one
 * to do: the console runs on the engine, in a session of its own, so every
 * recipe already outlives the app being closed and comes back where it was. The
 * flag used to type `tmux new-session -A -s …` into the shell first — a bare
 * `tmux`, which is the machine's own server with the machine's own config — and
 * then poll for the client to attach before sending a step, because sending in
 * the same tick lost the race to tmux taking the shell.
 */
export function runRecipeSteps(root: string, steps: string[], _wrapInTmux?: boolean): { ran: boolean; reason?: "in-tmux" } {
  /* The refusal that used to live here is gone with the flag that needed it.
     It existed because a console that had entered tmux would type a step at
     whatever owned the active pane — an agent, an editor — and the full-screen
     guard waves tmux through, since it cannot see the pane's program. Keeping
     it now would refuse EVERY recipe, because the console is always in tmux.
     What is left guarding that case is `runInConsole`, which answers false
     rather than typing when the shell will not take a line. */
  for (const line of steps) runInConsole(root, line);
  return { ran: true };
}

/**
 * Fire the commands marked "run when the app starts".
 *
 * Called once per app load, once the live socket is up. The steps go to the
 * docked console — the same surface every recipe runs in — so the console's
 * shell starts tmux, attaches to the last session, whatever the saved lines
 * say, whether or not the console is on screen. The saved set cannot contain
 * a boot recipe with parameters, an ask-first, or a destructive line: the
 * server refuses those at save time AND strips `boot` from a hand-written
 * file that carries them anyway, so nothing this side ever meets one that
 * would need asking or skipping.
 *
 * A module flag rather than a caller's ref: the caller (App) re-renders for
 * many reasons, but "this app load" is exactly the lifetime of this module.
 */
let bootFired = false;
export function runBootRecipes(): void {
  if (bootFired) return;
  bootFired = true;
  const root = consoleRoot();
  if (!root) return;
  // Retried like the command bar's own first read: the window is up before
  // the sidecar is listening, and a fetch that loses that race must not lose
  // the whole automation. Four goes over ~8s, then it stops.
  retryLoad(() => api.recipes(root)
    .then(({ recipes }) => {
      for (const r of recipes) if (r.boot) runRecipeSteps(root, r.steps);
      return true;
    })
    .catch(() => false));
}

/**
 * Ask for the values, then show the exact lines before anything happens.
 *
 * The preview is not decoration and not a courtesy: it is the moment the person
 * running this can see what their typing turned into. It comes from the server,
 * already substituted and quoted, so what is shown is literally what will be
 * sent — not this component's idea of it.
 */
export function RunDialog({ r, repos, onClose, onNote, onRunStep, targetInTmux }: {
  r: Recipe; repos: GitRepoRef[]; onClose: () => void; onNote: (n: { ok: boolean; text: string }) => void;
  /** How to run a step, when the caller has a shell in view (a command bar's
   *  focused pane or console). Absent from Settings, which has no shell on
   *  screen and so runs in the docked console instead. */
  onRunStep?: (cmd: string) => void;
  /** Whether that shell is inside tmux. Only consulted when `onRunStep` is set;
   *  otherwise the console's own tmux state stands in. */
  targetInTmux?: boolean;
}) {
  /*
   * What the boxes start as.
   *
   * A parameter that arrives filled in is not a parameter — and the app already
   * knows the answer to most of them: which checkout the console is standing
   * in, which repository that belongs to. Asking somebody to pick from a list
   * the thing they are visibly already inside is the difference between a form
   * and a chore.
   *
   * A guess, never a decision: it is the selected value, still a dropdown, and
   * changing it is one click. And it is computed once, on open, rather than
   * being live — a default that moves under you while you are reading the
   * preview is worse than one that is merely stale.
   */
  const [values, setValues] = useState<Record<string, string>>(() => {
    const here = consoleRoot();
    const out: Record<string, string> = {};
    for (const p of r.params ?? []) {
      if (p.value && p.type !== "flag") { out[p.key] = p.value; continue; }
      // A flag's default is the author's to set: `--force` that arrives ticked
      // is a different feature from one you tick.
      if (p.type === "flag") { if (p.value?.startsWith("!")) out[p.key] = "1"; continue; }
      if ((p.type === "worktree" || p.type === "repo") && here) out[p.key] = here;
    }
    return out;
  });
  const [preview, setPreview] = useState<{ steps: string[]; confirm: boolean; missing: string[] } | null>(null);

  useEffect(() => {
    let gone = false;
    void api.recipeRender(r.id, values).then((res) => {
      if (gone || !res.ok) return;
      setPreview({ steps: res.steps ?? [], confirm: !!res.confirm, missing: res.missing ?? [] });
    }).catch(() => {});
    return () => { gone = true; };
  }, [r.id, values]);

  // A recipe that wants a plain shell cannot run once its target shell is inside
  // tmux — the line would land in the pane's program, not at a prompt. The
  // target is the caller's shell when it has one (`onRunStep`), otherwise the
  // docked console. Read once per render: it flips only on attach/detach, not
  // while this small dialog is open.
  const where = onRunStep ? "the shell" : "the console";
  /* Only the caller's own shell can still be the wrong place to type. The
     console cannot: it is the engine's, and a step going there is the whole
     point of it. A shell the user is driving may have an agent in its active
     pane, and the full-screen guard cannot see through tmux to say so. */
  const inTmux = onRunStep ? !!targetInTmux : false;

  const go = () => {
    if (!preview || preview.missing.length || inTmux) return;
    if (onRunStep) {
      for (const s of preview.steps) onRunStep(s);
      onNote({ ok: true, text: `${r.name} sent to ${where}` });
      onClose();
      return;
    }
    runRecipeSteps(consoleRoot(), preview.steps);
    onNote({ ok: true, text: `${r.name} sent to the console` });
    onClose();
  };

  const style = { background: "var(--bg2)", border: edge(22), color: "var(--text)" };
  return (
    <div className="rounded-xl p-3 flex flex-col gap-2.5" style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
      <div className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>Run {r.name}</div>
      {(r.params ?? []).map((p) => (
        <label key={p.key} className="flex flex-col gap-1">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{p.label || p.key}</span>
          {p.type === "flag" ? (
            <label className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text2)" }}>
              <input type="checkbox" checked={values[p.key] === "1"} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.checked ? "1" : "0" }))} />
              {(p.value || `--${p.key}`).replace(/^!/, "")}
            </label>
          ) : p.type === "choice" ? (
            <select value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}>
              <option value="">—</option>
              {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : p.type === "repo" || p.type === "worktree" ? (
            <CheckoutPicker repos={repos} value={values[p.key] ?? ""}
              onPick={(r) => setValues((v) => ({ ...v, [p.key]: r }))}
              placeholder="—" triggerMaxWidth={220} />
          ) : (
            <input value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style} spellCheck={false} />
          )}
        </label>
      ))}

      <div className="flex flex-col gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Will run</span>
        <pre className="text-[11px] font-mono px-2 py-1.5 rounded-lg overflow-x-auto whitespace-pre"
          style={{ ...style, margin: 0, color: "var(--text2)" }}>{preview?.steps.join("\n") || "…"}</pre>
      </div>

      {preview?.confirm && (
        <div className="text-[10.5px] px-2 py-1 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          This one is not easily undone. Read the lines above before you run it.
        </div>
      )}
      {!!preview?.missing.length && (
        <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>Still needs: {preview.missing.join(", ")}</div>
      )}
      {inTmux && (
        <div className="text-[10.5px] px-2 py-1 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          {where === "the shell" ? "This shell" : "The console"} is inside tmux, so this would type into the pane's program, not a prompt. It runs from a plain shell — detach it (Ctrl-b d) or reopen the app first.
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={go} disabled={!preview || !!preview.missing.length || inTmux}
          className="text-[11px] px-3 py-1 rounded-lg"
          style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
            border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)", color: "var(--text)",
            opacity: !preview || preview.missing.length || inTmux ? 0.4 : 1 }}>
          {preview?.confirm ? "Run it anyway" : "Run"}
        </button>
        <button onClick={onClose} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text3)" }}>Cancel</button>
      </div>
    </div>
  );
}
