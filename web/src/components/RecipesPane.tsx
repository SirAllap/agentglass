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
import { useCallback, useEffect, useId, useState } from "react";
import { api } from "../lib/api.ts";
import { retryLoad } from "../lib/retryLoad.ts";
import type { Recipe, RecipeParam, GitRepoRef } from "../../../shared/types.ts";
import { consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { FormInput } from "./settings/shell/FormInput.tsx";
import { Section } from "./settings/shell/Section.tsx";
import { SettingRow } from "./settings/shell/SettingRow.tsx";
import { DangerAction, GroupActions } from "./settings/save/index.ts";
import { Select } from "./Select.tsx";
import { Switch } from "./SettingRow.tsx";
import { MAX_COMMAND_PINS, RECIPE, togglePin, usePinMap } from "./CommandBar.tsx";
import { differs } from "./SettingsListEditor.tsx";
import { useReportSaving } from "./SettingsPageState.tsx";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { IconLabel, PlusIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { CloseIcon } from "./CloseButton.tsx";
import { Button, INPUT, INPUT_STYLE, EDGE, LINE, Segmented } from "./workspace/Chrome.tsx";
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
  const [busy, setBusy] = useState(false);
  useReportSaving("recipes", busy);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [q, setQ] = useState("");
  const [narrow, setNarrow] = useState<"all" | "pinned" | "repo">("all");
  const pins = usePinMap();
  /* A pin belongs to a repository's command bar: a command kept for one repo is pinned there, an everywhere one in the repo the console is on. */
  const pinRoot = (r: Recipe) => (r.scope === "repo" && r.repo ? r.repo : consoleRoot());
  const isPinned = (r: Recipe) => !!r.id && (pins[pinRoot(r)] ?? []).includes(`${RECIPE}${r.id}`);

  const load = useCallback(async () => {
    try { const l = (await api.recipes()).recipes; setList(l); return l; } catch { setList([]); return []; }
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
  }, [open, load]);

  const save = async (r: Recipe) => {
    setBusy(true);
    try {
      const res = await api.recipeSave(r);
      if (!res.ok) { setNote({ ok: false, text: res.error ?? "That did not save" }); return; }
      setNote({ ok: true, text: `${r.name} saved` });
      const fresh = await load();
      // Saved: the same one stays open (a new one gets its id from the server, so it is found by name).
      setEditing(fresh.find((x) => x.id === (r.id || res.recipe?.id)) ?? fresh.find((x) => x.name === r.name) ?? null);
    } finally { setBusy(false); }
  };
  const drop = async (r: Recipe) => {
    await api.recipeRemove(r.id).catch(() => {});
    setNote({ ok: true, text: `${r.name} removed. Nothing else was touched.` });
    setEditing(null);
    setRunning(null);
    await load();
  };

  const saved = editing?.id ? list?.find((x) => x.id === editing.id) : undefined;
  const ql = q.trim().toLowerCase();
  const match = (r: Recipe) => (!ql || `${r.name} ${r.desc} ${r.steps.join(" ")}`.toLowerCase().includes(ql))
    && (narrow === "all" || (narrow === "pinned" ? isPinned(r) : r.scope === "repo"));
  const repoName = (root: string) => repos.find((x) => x.root === root)?.name || root.split("/").pop() || "repository";
  const shown = (list ?? []).filter(match);

  return (
    <>
      <Section id="commands" title="Commands" intro="Things you type often, kept with the parts that change asked for when you run them.">
        {list === null && <SettingRow kind="fact" label="Reading your recipes" value="…" />}
        {list?.length === 0 && (
          <SettingRow kind="control" label="No commands yet" help="Save one you have typed three times this week."
            control={<Button onClick={() => setEditing(blank())}>New recipe</Button>} />
        )}
        {(list?.length ?? 0) > 6 && (
          <SettingRow kind="control" label="Filter commands" help={`Search ${list!.length} commands by name or step.`}
            control={<>
              <FormInput aria-label="Filter commands" placeholder="Search commands" value={q} onChange={(e) => setQ(e.target.value)} className={INPUT} style={INPUT_STYLE} />
              <Segmented<"all" | "pinned" | "repo"> label="Show" value={narrow} onChange={setNarrow}
                options={[{ id: "all", label: `All ${list!.length}` }, { id: "pinned", label: `Pinned ${list!.filter(isPinned).length}` }, { id: "repo", label: `One repo ${list!.filter((r) => r.scope === "repo").length}` }]} />
            </>} />
        )}
        {list && list.length > 0 && shown.length === 0 && <SettingRow kind="fact" label="Nothing matches" value="" />}
        {shown.map((r) => (
          <div key={r.id} data-recipe-id={r.id}>
            <SettingRow kind="control" label={r.name}
              help={`${r.scope === "repo" && r.repo ? `${repoName(r.repo)} only. ` : ""}${isPinned(r) ? "Pinned. " : ""}${r.boot ? "Runs at start. " : ""}${r.steps.some((l) => l.trim()) ? "" : r.desc}`.trim().slice(0, 120) || undefined}
              code={r.steps.find((l) => l.trim())?.slice(0, 120)}
              control={<>
                <Button onClick={() => { setEditing(r); setRunning(null); }}>Edit</Button>
                <Button onClick={() => { setRunning(r); }}><IconLabel icon={<PlayGlyph />}>Run now</IconLabel></Button>
                <DangerAction label="Delete" onConfirm={() => drop(r)} />
              </>} />
          </div>
        ))}
        {list && list.length > 0 && !editing && (
          <SettingRow kind="control" label="Write a new command" help="It joins the list and the command bar menu."
            control={<Button onClick={() => setEditing(blank())}>New recipe</Button>} />
        )}
        {note && (
          <div role={note.ok ? "status" : "alert"} className="px-3 py-2 text-[12px]" style={{ color: note.ok ? "var(--success-ink)" : "var(--error-ink)" }}>{note.text}</div>
        )}
      </Section>
      {editing && (
        <RecipeEditor r={editing} saved={saved} repos={repos} busy={busy} pinned={isPinned(editing)} pinRoot={pinRoot(editing)} onChange={setEditing} onSave={save}
          onCancel={() => setEditing(saved ?? null)} />
      )}
      {running && <RunForm r={running} repos={repos} onClose={() => setRunning(null)} onNote={setNote} />}
    </>
  );
}

/** A yes/no as a shell row: the house switch on the right. */
function SwitchRow({ label, help, on, disabled, onToggle }: { label: string; help: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <SettingRow kind="control" label={label} help={help}
      control={<button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle}><Switch on={on} /></button>} />
  );
}

const PlayGlyph = () => <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden><path d="M2 1.2v7.6L8.6 5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;

/** One stacked field's control: the kit's input height and edge. */
const FIELD = `w-full ${INPUT}`;

/** The editor: a section of rows (one per field) and one primary Save. Delete lives on the list row. */
function RecipeEditor({ r, saved, repos, busy, pinned, pinRoot, onChange, onSave, onCancel }: {
  r: Recipe; saved?: Recipe; repos: GitRepoRef[]; busy: boolean; pinned: boolean; pinRoot: string;
  onChange: (r: Recipe) => void; onSave: (r: Recipe) => void; onCancel: () => void;
}) {
  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;
  const set = (patch: Partial<Recipe>) => onChange({ ...r, ...patch });
  const setParam = (i: number, patch: Partial<RecipeParam>) =>
    set({ params: (r.params ?? []).map((x, j) => j === i ? { ...x, ...patch } : x) });
  /** Boot and the two things that would need asking are mutually exclusive:
   *  the server refuses saving the combination, so the editor says so up front. */
  const cannotBoot = !!(r.params?.length) || !!r.confirm;
  const pinsFull = (usePinMap()[pinRoot] ?? []).length >= MAX_COMMAND_PINS;
  const wide = { minWidth: 260 };
  return (
    <Section id="commands-edit" title={r.id ? `Edit ${r.name || "recipe"}` : "New recipe"}>
      <SettingRow kind="control" label="Name" help="How you will call it."
        control={<FormInput id={f("name")} aria-label="Name" value={r.name} onChange={(e) => set({ name: e.target.value })} className={FIELD} style={{ ...INPUT_STYLE, ...wide }} />} />
      <SettingRow kind="control" label="What it does" help="One or two lines."
        control={<textarea id={f("desc")} aria-label="What it does" value={r.desc} onChange={(e) => set({ desc: e.target.value })} rows={2}
          className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none bg-[var(--surface-inset)] text-[var(--text)]" style={{ ...INPUT_STYLE, ...wide, resize: "vertical" }} />} />
      <SettingRow kind="control" label="Steps" help="One per line. {{name}} marks a parameter."
        control={<textarea id={f("steps")} aria-label="Steps" value={r.steps.join("\n")} onChange={(e) => set({ steps: e.target.value.split("\n") })}
          rows={Math.max(3, r.steps.length + 1)} spellCheck={false}
          className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none font-mono bg-[var(--surface-inset)] text-[var(--text)]" style={{ ...INPUT_STYLE, ...wide, resize: "vertical" }} />} />
      {startsClaude(r) && (
        <SettingRow kind="control" label="Permission mode" help="How a step that starts claude asks before a tool runs."
          control={<LaunchModeSelect value={r.permissionMode} onChange={(m) => set({ permissionMode: m })} />} />
      )}
      <SettingRow kind="control" label="Where it applies" help="Everywhere, or one repository only."
        control={<Segmented<Recipe["scope"]> track label="Where it applies" value={r.scope}
          options={[{ id: "global", label: "Everywhere" }, { id: "repo", label: "One repository" }]}
          onChange={(scope) => set({ scope, repo: scope === "global" ? undefined : (r.repo || repos[0]?.root) })} />} />
      {r.scope === "repo" && (
        <SettingRow kind="control" label="Repository" help="The one this command belongs to."
          control={<Select value={r.repo ?? ""} title="Repository" onChange={(v) => set({ repo: v })}
            options={repos.map((x) => ({ value: x.root, label: x.name || x.root }))} />} />
      )}
      <SwitchRow label="Pinned" on={pinned} disabled={!r.id || (!pinned && pinsFull)}
        help={!r.id ? "Save it first, then pin it." : `Sits in the command bar, ${MAX_COMMAND_PINS} at most per repository.`}
        onToggle={() => { togglePin(pinRoot, `${RECIPE}${r.id}`); }} />
      <SwitchRow label="Always ask first" on={!!r.confirm} disabled={!!r.boot}
        help={r.boot ? "A command that runs at start has nobody to ask." : "Shows what will run and waits for you."}
        onToggle={() => set({ confirm: !r.confirm })} />
      <SwitchRow label="Run when the app starts" on={!!r.boot} disabled={cannotBoot}
        help={cannotBoot ? "Remove the parameters or ask-first to run it at start." : "Runs in the docked console on every open."}
        onToggle={() => set(!r.boot ? { boot: true, confirm: false } : { boot: false })} />
      <SettingRow kind="control" label="Parameters" help="Values asked for when you run it. Keep them next to the steps."
        control={<Button onClick={() => set({ boot: false, params: [...(r.params ?? []), { key: "", label: "", type: "text" }] })}>
          <IconLabel icon={<PlusIcon size={ICON.xs} />}>Add parameter</IconLabel>
        </Button>} />
      {!!r.params?.length && (
        <div className="px-3 pb-2.5 agx-ptable" role="table" aria-label="Parameters">
          <div className="agx-ptable-h" role="row"><span>Name</span><span>Type</span><span>Choices</span><span>Flag</span><span /></div>
          {r.params.map((p, i) => (
            <div key={i} className="agx-ptable-r" role="row">
              <FormInput aria-label={`Parameter ${i + 1} name`} value={p.key} onChange={(e) => setParam(i, { key: e.target.value })}
                className={`t-mono ${FIELD}`} style={INPUT_STYLE} />
              <Select value={p.type} title={`Parameter ${i + 1} type`} onChange={(v) => setParam(i, { type: v as RecipeParam["type"] })}
                options={PARAM_TYPES.map((t) => ({ value: t, label: t }))} />
              <FormInput aria-label={`Parameter ${i + 1} choices, separated by commas`} disabled={p.type !== "choice"} placeholder={p.type === "choice" ? "one, two, three" : "—"}
                value={(p.options ?? []).join(", ")}
                onChange={(e) => setParam(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                className={FIELD} style={INPUT_STYLE} />
              <FormInput aria-label={`Parameter ${i + 1} flag`} disabled={p.type !== "flag"} placeholder={p.type === "flag" ? "--rebuild-fe" : "—"}
                value={p.type === "flag" ? p.value ?? "" : ""} onChange={(e) => setParam(i, { value: e.target.value })}
                className={`t-mono ${FIELD}`} style={INPUT_STYLE} />
              <button type="button" className="agx-ptable-x" aria-label={`Remove parameter ${i + 1}`} title={`Remove parameter ${i + 1}`}
                onClick={() => set({ params: (r.params ?? []).filter((_, j) => j !== i) })}><CloseIcon size={ICON.xs} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="px-3 py-2.5" style={{ borderTop: LINE }}>
        <GroupActions primary="Save recipe" dirty={!r.id || differs(r, saved)} busy={busy} onPrimary={() => onSave(r)} onCancel={onCancel} />
      </div>
    </Section>
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
 * to do: the console runs on the engine, in the console window of the
 * checkout's session, so every
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
              <FormInput type="checkbox" checked={values[p.key] === "1"} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.checked ? "1" : "0" }))} />
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
            <FormInput value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
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

/** The same run, as a section of its own in Settings: the values as rows, the lines that will run, one primary Run. The command bar keeps its small dialog; both read the same hook. */
function RunForm({ r, repos, onClose, onNote }: {
  r: Recipe; repos: GitRepoRef[]; onClose: () => void; onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const uid = useId();
  const { values, setValues, preview, go, inTmux } = useRecipeRun({ r, onClose, onNote });
  const set = (k: string, v: string) => setValues((cur) => ({ ...cur, [k]: v }));
  const blocked = !preview || !!preview.missing.length || inTmux;
  return (
    <Section id="commands-run" title={`Run ${r.name}`}>
      {(r.params ?? []).map((p) => {
        const id = `${uid}-${p.key}`;
        const label = p.label || p.key;
        if (p.type === "flag") {
          return (
            <SettingRow key={p.key} kind="control" label={label} help={(p.value || `--${p.key}`).replace(/^!/, "")}
              control={<FormInput type="checkbox" aria-label={label} checked={values[p.key] === "1"} onChange={(e) => set(p.key, e.target.checked ? "1" : "0")} />} />
          );
        }
        return (
          <SettingRow key={p.key} kind="control" label={label}
            control={p.type === "choice" ? (
              <select id={id} aria-label={label} value={values[p.key] ?? ""} onChange={(e) => set(p.key, e.target.value)} className={INPUT} style={INPUT_STYLE}>
                <option value="">—</option>
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : p.type === "repo" || p.type === "worktree" ? (
              <div id={id}><CheckoutPicker repos={repos} value={values[p.key] ?? ""} onPick={(v) => set(p.key, v)} placeholder="—" triggerMaxWidth={320} /></div>
            ) : (
              <FormInput id={id} aria-label={label} value={values[p.key] ?? ""} onChange={(e) => set(p.key, e.target.value)} className={INPUT} style={INPUT_STYLE} spellCheck={false} />
            )} />
        );
      })}
      <SettingRow kind="control" label="Will run" help="Exactly what is sent, already filled in."
        control={<pre className="text-[12px] font-mono px-2.5 py-2 rounded-lg overflow-x-auto whitespace-pre m-0"
          style={{ background: "var(--surface-inset)", color: "var(--text2)", maxWidth: 360 }}>{preview?.steps.join("\n") || "…"}</pre>} />
      {preview?.confirm && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--warning-ink)" }}>This one is not easily undone. Read the lines above before you run it.</div>}
      {!!preview?.missing.length && <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>Still needs: {preview.missing.join(", ")}</div>}
      {inTmux && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--warning-ink)" }}>The console is inside tmux, so this would type into the pane's program, not a prompt.</div>}
      <div className="px-3 py-2.5 flex gap-2" style={{ borderTop: LINE }}>
        <Button tone="primary" disabled={blocked} onClick={go}>{preview?.confirm ? "Run it anyway" : "Run"}</Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Section>
  );
}
