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
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { retryLoad } from "../lib/retryLoad.ts";
import type { Recipe, RecipeParam, GitRepoRef } from "../../../shared/types.ts";
import { consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { Field, SettingsCard, SettingsForm, helpIdFor } from "./SettingsKit.tsx";
import { EditorFoot, EditorPanel, ListBar, ListEditorSplit, ListPanel, NewButton, NothingSelected, differs } from "./SettingsListEditor.tsx";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { IconLabel, PlusIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Button, INPUT, INPUT_STYLE, EDGE } from "./workspace/Chrome.tsx";
import { LaunchModeBadge, LaunchModeSelect } from "./LaunchMode.tsx";

/** Same test as the server's (recipes.ts withLaunchFlags): a step whose first word is `claude`. */
const startsClaude = (r: Recipe) => r.steps.some((l) => /^\s*(?:exec\s+)?claude(?=\s|$)/.test(l));

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
  const [q, setQ] = useState("");
  const firstShown = useRef(false);

  const load = useCallback(async () => {
    try { const l = (await api.recipes()).recipes; setList(l); return l; } catch { setList([]); return []; }
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
  }, [open, load]);

  /* The first command is open when the page is: an editor with nothing in it, beside a list, reads as broken. */
  useEffect(() => { if (list?.length && !editing && !firstShown.current) { firstShown.current = true; setEditing(list[0]!); } }, [list, editing]);

  const save = async (r: Recipe) => {
    const res = await api.recipeSave(r);
    if (!res.ok) { setNote({ ok: false, text: res.error ?? "That did not save" }); return; }
    setNote({ ok: true, text: `${r.name} saved` });
    const fresh = await load();
    // Saved: the same one stays open (a new one gets its id from the server, so it is found by name).
    setEditing(fresh.find((x) => x.id === (r.id || res.recipe?.id)) ?? fresh.find((x) => x.name === r.name) ?? null);
  };
  const drop = async (r: Recipe) => {
    await api.recipeRemove(r.id).catch(() => {});
    setNote({ ok: true, text: `${r.name} removed — nothing else was touched` });
    setEditing(null);
    setRunning(null);
    await load();
  };

  const saved = editing?.id ? list?.find((x) => x.id === editing.id) : undefined;
  const ql = q.trim().toLowerCase();
  const match = (r: Recipe) => !ql || `${r.name} ${r.desc} ${r.steps.join(" ")}`.toLowerCase().includes(ql);
  /* Everywhere first, then one section per repository the saved ones name. */
  const repoRoots = [...new Set((list ?? []).filter((r) => r.scope !== "global").map((r) => r.repo ?? ""))];
  const repoName = (root: string) => repos.find((x) => x.root === root)?.name || root.split("/").pop() || "repository";
  const entry = (r: Recipe) => ({
    id: r.id, title: r.name,
    tags: r.boot ? ["at start"] : undefined,
    badge: startsClaude(r) ? <LaunchModeBadge mode={r.permissionMode} /> : undefined,
    sub: <span className="t-mono">{r.steps.find((l) => l.trim()) ?? r.desc}</span>,
  });
  const sections = [
    { id: "global", title: "Everywhere", onAdd: () => setEditing(blank()), addLabel: "New recipe, everywhere",
      entries: (list ?? []).filter((r) => r.scope === "global" && match(r)).map(entry) },
    ...repoRoots.map((root) => ({
      id: root, title: `${repoName(root)} only`,
      onAdd: () => setEditing({ ...blank(), scope: "repo" as const, repo: root }), addLabel: `New recipe in ${repoName(root)}`,
      entries: (list ?? []).filter((r) => r.scope !== "global" && (r.repo ?? "") === root && match(r)).map(entry),
    })),
  ];

  /* A list beside the editor: the commands on the left, the one open on the right. Run… moved
     into the editor's head, where the one you are looking at is; its form is a card under the
     split, so the list never moves to make room for it. */
  return (
    <>
      <ListBar q={q} onQ={setQ} placeholder={`Filter ${list?.length ?? 0} commands`} label="Filter commands">
        <NewButton onClick={() => setEditing(blank())}>New recipe</NewButton>
      </ListBar>
      {note && (
        <div role={note.ok ? "status" : "alert"} className="agx-le-note text-[12px] pb-3"
          style={{ color: note.ok ? "var(--success-ink)" : "var(--error-ink)" }}>
          {note.text}
        </div>
      )}
      <ListEditorSplit
        list={<ListPanel sections={sections} selected={editing?.id || null}
          onSelect={(id) => { const r = list?.find((x) => x.id === id); if (r) { setEditing(r); setRunning(null); } }}
          nothing={!list ? "Reading your recipes…" : list.length ? "Nothing matches." : "Nothing saved yet. The first one is usually a thing you have typed three times this week."} />}
        editor={editing
          ? <Editor r={editing} saved={saved} repos={repos} onChange={setEditing} onSave={save} onDrop={drop}
              onRun={editing.id ? () => setRunning(editing) : undefined}
              onCancel={() => setEditing(saved ?? null)} />
          : <NothingSelected noun="recipe" label="Command" onNew={() => setEditing(blank())} />} />
      {running && <RunForm r={running} repos={repos} onClose={() => setRunning(null)} onNote={setNote} />}
    </>
  );
}

/** One stacked field's control: the kit's input height and edge. */
const FIELD = `w-full ${INPUT}`;

/**
 * The editor, a card of its own under the list: one form of stacked labelled
 * fields, one primary Save, and Delete up in the card's header where a Save
 * press cannot land on it.
 */
function Editor({ r, saved, repos, onChange, onSave, onDrop, onRun, onCancel }: {
  r: Recipe; saved?: Recipe; repos: GitRepoRef[];
  onChange: (r: Recipe) => void; onSave: (r: Recipe) => void; onDrop: (r: Recipe) => void; onRun?: () => void; onCancel: () => void;
}) {
  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;
  const set = (patch: Partial<Recipe>) => onChange({ ...r, ...patch });
  const setParam = (i: number, patch: Partial<RecipeParam>) =>
    set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, ...patch } : x) });
  /** Boot and the two things that would need asking are mutually exclusive —
   *  the server refuses saving the combination, so the editor says so up
   *  front rather than letting the save be the first to find out. */
  const cannotBoot = !!(r.params?.length) || !!r.confirm;
  return (
    <EditorPanel label="Command" title={r.name || "New recipe"}
      chips={r.id ? undefined : [{ tone: "info", text: "Draft" }]}
      actions={r.id ? <>
        {onRun && <Button onClick={onRun}>Run…</Button>}
        <Button tone="danger" onClick={() => onDrop(r)}>Delete</Button>
      </> : undefined}>
          <SettingsForm label={r.id ? "Edit recipe" : "New recipe"} onSubmit={() => onSave(r)}>
            <div className="agx-le-body">
            <Field label="Name" htmlFor={f("name")} help="How you will call it.">
              <input id={f("name")} value={r.name} onChange={(e) => set({ name: e.target.value })}
                aria-describedby={helpIdFor(f("name"))} className={FIELD} style={INPUT_STYLE} />
            </Field>
            <Field label="What it does" htmlFor={f("desc")}>
              {/* Two lines, not one: a sentence about what a command does is
                  longer than the 480px a form field gets, and an input would
                  cut it off at the edge. */}
              <textarea id={f("desc")} value={r.desc} onChange={(e) => set({ desc: e.target.value })} rows={2}
                className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none bg-[var(--surface-inset)] text-[var(--text)]"
                style={{ ...INPUT_STYLE, resize: "vertical" }} />
            </Field>

            {/* One step per line. A textarea rather than a list of rows: these
                are lines of shell, and people write them the way they write
                shell. */}
            <Field label="Steps" htmlFor={f("steps")} help={<>One per line. {"{{name}}"} marks a parameter.</>}>
              <textarea id={f("steps")} value={r.steps.join("\n")} onChange={(e) => set({ steps: e.target.value.split("\n") })}
                aria-describedby={helpIdFor(f("steps"))}
                rows={Math.max(3, r.steps.length + 1)} spellCheck={false}
                className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none font-mono bg-[var(--surface-inset)] text-[var(--text)]"
                style={{ ...INPUT_STYLE, resize: "vertical" }} />
            </Field>

            {/* Only for a command that starts Claude: the server adds the flags
                to a step whose first word is `claude`, and to nothing else. */}
            {startsClaude(r) && (
              <Field label="Permission mode" htmlFor={f("mode")} help="For a step that starts claude: how it asks before a tool runs.">
                <LaunchModeSelect id={f("mode")} value={r.permissionMode} className={`w-full ${INPUT}`} style={INPUT_STYLE}
                  onChange={(m) => set({ permissionMode: m })} />
              </Field>
            )}

            <Field label="Where it applies" htmlFor={f("scope")}>
              <select id={f("scope")} value={r.scope} className={`w-56 ${INPUT}`} style={INPUT_STYLE}
                onChange={(e) => set({ scope: e.target.value as Recipe["scope"], repo: e.target.value === "global" ? undefined : (r.repo || repos[0]?.root) })}>
                <option value="global">Everywhere</option>
                <option value="repo">One repository</option>
              </select>
            </Field>
            {r.scope === "repo" && (
              <Field label="Repository" htmlFor={f("repo")}>
                <select id={f("repo")} value={r.repo ?? ""} onChange={(e) => set({ repo: e.target.value })}
                  className={FIELD} style={INPUT_STYLE}>
                  {repos.map((x) => <option key={x.root} value={x.root}>{x.name || x.root}</option>)}
                </select>
              </Field>
            )}

            {/* The "run inside tmux" box was here, promising "survives closing
                the app". It kept that promise on the MACHINE's tmux, by typing
                a bare `tmux new-session` into the shell. The console runs on
                the engine now and every recipe outlives the app already, so
                the box had nothing left to offer. The stored flag is left
                alone rather than migrated away — an old recipe carrying it is
                not wrong, it is just describing something that is now true of
                all of them. */}
            <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)" }}
              title={r.boot ? "A command that runs at start fires with nobody to ask" : undefined}>
              <input type="checkbox" checked={!!r.confirm} onChange={(e) => set({ confirm: e.target.checked })} disabled={!!r.boot} />
              Always ask first
            </label>
            {/* A boot recipe runs the moment the app opens, with nobody to fill
                a box or click anything. The server refuses saving one that has
                parameters, asks first, or reads as destructive — these two
                checkboxes just keep the editor from leading somewhere the save
                would refuse. */}
            <label className="flex items-start gap-2 text-[12px]" style={{ color: cannotBoot ? "var(--text4)" : "var(--text2)" }}
              title={cannotBoot ? "Remove the parameters or the ask-first to run it at start" : undefined}>
              <input type="checkbox" className="mt-0.5" checked={!!r.boot} disabled={cannotBoot}
                onChange={(e) => set(e.target.checked ? { boot: true, confirm: false } : { boot: false })} />
              <span>Run when the app starts<span className="block agx-field-h">In the docked console, on every open.</span></span>
            </label>

            {/* Parameters. Kept next to the steps that use them, because the
                only way to get a `{{key}}` right is to see both at once. */}
            <div className="flex flex-col gap-2">
              <span className="agx-field-l">Parameters</span>
              {(r.params ?? []).map((p, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-lg p-3" style={{ background: "var(--surface-inset)" }}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px]" style={{ color: "var(--text2)" }}>Parameter {i + 1}</span>
                    <button type="button" className="agx-textlink text-[12px]"
                      onClick={() => set({ params: (r.params ?? []).filter((_, j) => j !== i) })}>Remove parameter {i + 1}</button>
                  </div>
                  <Field label="Name" htmlFor={f(`p${i}-key`)}>
                    <input id={f(`p${i}-key`)} value={p.key} onChange={(e) => setParam(i, { key: e.target.value })}
                      className={`t-mono ${FIELD}`} style={INPUT_STYLE} />
                  </Field>
                  <Field label="Type" htmlFor={f(`p${i}-type`)}>
                    <select id={f(`p${i}-type`)} value={p.type} onChange={(e) => setParam(i, { type: e.target.value as RecipeParam["type"] })}
                      className={`w-40 ${INPUT}`} style={INPUT_STYLE}>
                      {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                  {p.type === "choice" && (
                    <Field label="Choices" htmlFor={f(`p${i}-opts`)} help="Separated by commas.">
                      <input id={f(`p${i}-opts`)} value={(p.options ?? []).join(", ")}
                        onChange={(e) => setParam(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                        aria-describedby={helpIdFor(f(`p${i}-opts`))} placeholder="one, two, three" className={FIELD} style={INPUT_STYLE} />
                    </Field>
                  )}
                  {p.type === "flag" && (
                    <Field label="Flag" htmlFor={f(`p${i}-flag`)}>
                      <input id={f(`p${i}-flag`)} value={p.value ?? ""} onChange={(e) => setParam(i, { value: e.target.value })}
                        placeholder="--rebuild-fe" className={`t-mono ${FIELD}`} style={INPUT_STYLE} />
                    </Field>
                  )}
                </div>
              ))}
              <div>
                <Button onClick={() => set({ boot: false, params: [...(r.params ?? []), { key: "", label: "", type: "text" }] })}>
                  <IconLabel icon={<PlusIcon size={ICON.xs} />}>Add parameter</IconLabel>
                </Button>
              </div>
            </div>

            </div>
            <EditorFoot dirty={!r.id || differs(r, saved)} canSave noun="recipe" onCancel={onCancel} />
          </SettingsForm>
    </EditorPanel>
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

/** What a recipe's run needs, shared by the command bar's dialog and the
 *  settings form: the values, the server's preview of the lines, and the send. */
function useRecipeRun({ r, onClose, onNote, onRunStep, targetInTmux }: {
  r: Recipe; onClose: () => void; onNote: (n: { ok: boolean; text: string }) => void;
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

  return { values, setValues, preview, go, inTmux, where };
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
  const { values, setValues, preview, go, inTmux, where } = useRecipeRun({ r, onClose, onNote, onRunStep, targetInTmux });
  const style = { background: "var(--surface-card)", border: EDGE, color: "var(--text)" };
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
              className={INPUT} style={INPUT_STYLE} spellCheck={false} />
          )}
        </label>
      ))}

      <div className="flex flex-col gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Will run</span>
        <pre className="text-[11px] font-mono px-2 py-1.5 rounded-lg overflow-x-auto whitespace-pre"
          style={{ ...style, margin: 0, color: "var(--text2)" }}>{preview?.steps.join("\n") || "…"}</pre>
      </div>

      {preview?.confirm && (
        <div className="text-[10.5px] px-2 py-1 rounded" style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          This one is not easily undone. Read the lines above before you run it.
        </div>
      )}
      {!!preview?.missing.length && (
        <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>Still needs: {preview.missing.join(", ")}</div>
      )}
      {inTmux && (
        <div className="text-[10.5px] px-2 py-1 rounded" style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
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

/**
 * The same run, as a card of its own in Settings: the values as stacked
 * labelled fields, the lines that will run under them, one primary Run. The
 * command bar keeps its small dialog; both read the same hook, so what is
 * previewed is what is sent in either place.
 */
function RunForm({ r, repos, onClose, onNote }: {
  r: Recipe; repos: GitRepoRef[]; onClose: () => void; onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const uid = useId();
  const { values, setValues, preview, go, inTmux } = useRecipeRun({ r, onClose, onNote });
  const set = (k: string, v: string) => setValues((cur) => ({ ...cur, [k]: v }));
  const blocked = !preview || !!preview.missing.length || inTmux;
  return (
    <SettingsCard title={`Run ${r.name}`}>
      <div className="agx-settings-row">
        <div className="agx-row-below">
          <SettingsForm label={`Run ${r.name}`} onSubmit={go}>
            {(r.params ?? []).map((p) => {
              const id = `${uid}-${p.key}`;
              const label = p.label || p.key;
              if (p.type === "flag") {
                return (
                  <label key={p.key} className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)" }}>
                    <input type="checkbox" checked={values[p.key] === "1"} onChange={(e) => set(p.key, e.target.checked ? "1" : "0")} />
                    {(p.value || `--${p.key}`).replace(/^!/, "")}
                  </label>
                );
              }
              return (
                <Field key={p.key} label={label} htmlFor={id}>
                  {p.type === "choice" ? (
                    <select id={id} value={values[p.key] ?? ""} onChange={(e) => set(p.key, e.target.value)}
                      className={`w-full ${INPUT}`} style={INPUT_STYLE}>
                      <option value="">—</option>
                      {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : p.type === "repo" || p.type === "worktree" ? (
                    <div id={id}>
                      <CheckoutPicker repos={repos} value={values[p.key] ?? ""}
                        onPick={(v) => set(p.key, v)} placeholder="—" triggerMaxWidth={320} />
                    </div>
                  ) : (
                    <input id={id} value={values[p.key] ?? ""} onChange={(e) => set(p.key, e.target.value)}
                      className={`w-full ${INPUT}`} style={INPUT_STYLE} spellCheck={false} />
                  )}
                </Field>
              );
            })}

            <div className="flex flex-col gap-1.5">
              <span className="agx-field-l">Will run</span>
              <pre className="text-[12px] font-mono px-2.5 py-2 rounded-lg overflow-x-auto whitespace-pre m-0"
                style={{ background: "var(--surface-inset)", color: "var(--text2)" }}>{preview?.steps.join("\n") || "…"}</pre>
            </div>

            {preview?.confirm && (
              <div role="alert" className="text-[12px]" style={{ color: "var(--warning-ink)" }}>
                This one is not easily undone. Read the lines above before you run it.
              </div>
            )}
            {!!preview?.missing.length && (
              <div className="agx-field-h">Still needs: {preview.missing.join(", ")}</div>
            )}
            {inTmux && (
              <div role="alert" className="text-[12px]" style={{ color: "var(--warning-ink)" }}>
                The console is inside tmux, so this would type into the pane's program, not a prompt.
              </div>
            )}

            <div className="agx-sform-actions">
              <Button type="submit" tone="primary" disabled={blocked}>{preview?.confirm ? "Run it anyway" : "Run"}</Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
          </SettingsForm>
        </div>
      </div>
    </SettingsCard>
  );
}
