/*
 * Commands: everything you can run from the Terminal, in one popover.
 *
 * Top to bottom: search the scrollback (it is a command people look for here),
 * the pinned ones (moved in from the strip, where a row of chips cost width
 * on every window), the project's own (saved, Makefile, package scripts),
 * git, and Settings folded away. One filter box covers all of it.
 *
 * It reuses what CommandBar already owns: the pins and their storage, the
 * command list and its cache, the run dialog for a saved command that asks for
 * values. CommandBar itself stays as the Docker console's control.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GitRepoRef, ProjectCommand, Recipe } from "../../../../shared/types.ts";
import { api, IS_DEMO } from "../../lib/api.ts";
import { clickupSetup } from "../../lib/clickupSetup.ts";
import { pinCounter, pinRows, settingsOpen, showPinHole, showScrollbackRow } from "../../lib/commandsPopover.ts";
import { HAS_BROWSER } from "../../lib/desktop.ts";
import { CaretIcon, SearchIcon, StarIcon, CommandIcon, PlusIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { retryLoad } from "../../lib/retryLoad.ts";
import { searchSettings, type SettingsPage } from "../../lib/settingsIndex.ts";
import { SETTINGS_PAGES as ALL_SETTINGS_PAGES } from "../../lib/settingsRows.gen.ts";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { addCustomPin, decodeCustomPin, GIT_COMMANDS, groupByDir, matchCommands, MAX_COMMAND_PINS, RECIPE, togglePin, useCommands, usePins } from "../CommandBar.tsx";
import { MenuRow } from "../ContextMenu.tsx";
import { RunDialog, runRecipeSteps } from "../RecipesPane.tsx";
import { Button, FilterField, GROUP_HEADING, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";

const SETTINGS_PAGES = HAS_BROWSER ? ALL_SETTINGS_PAGES : ALL_SETTINGS_PAGES.filter((p) => p.id !== "browser");
const SETTINGS_NO_KW = SETTINGS_PAGES.map((p) => ({ ...p, kw: "" }) as SettingsPage);
const WIDTH = 460;

type Cmd = ProjectCommand & { recipe?: Recipe };

export function CommandsPopover({ root, disabled, font, runTargetInTmux, onRun, onFind, onClose }: {
  root: string;
  disabled: boolean;
  font: string;
  onRun: (cmd: string) => void;
  /** Whether the shell being typed into is inside tmux (a plain-shell saved command will not type into it). */
  runTargetInTmux: boolean;
  /** Open Find over the focused pane. */
  onFind: () => void;
  /** Handing the keyboard back to the pane. */
  onClose: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const shut = () => { setOpen(false); onClose(); };
  return (
    <span ref={box} className="relative shrink-0 inline-flex">
      <Button size="strip" tone="quiet" square on={open || undefined} label="Commands" title="Commands: search the scrollback, pinned, project and git commands"
        aria-haspopup="menu" aria-expanded={open} disabled={!root || IS_DEMO} onClick={() => setOpen((o) => !o)}>
        <CommandIcon size={ICON.sm} />
      </Button>
      {open && (
        <AnchoredMenu anchor={box} align="right" minWidth={WIDTH} plain maxHeight={560} focus="input" keepTab onClose={shut}>
          <Body root={root} disabled={disabled} font={font} runTargetInTmux={runTargetInTmux} onRun={onRun} onFind={onFind} done={() => setOpen(false)} />
        </AnchoredMenu>
      )}
    </span>
  );
}

function Body({ root, disabled, font, runTargetInTmux, onRun, onFind, done }: {
  root: string; disabled: boolean; font: string; runTargetInTmux: boolean;
  onRun: (cmd: string) => void; onFind: () => void; done: () => void;
}) {
  const [query, setQuery] = useState("");
  const [foldedSettings, setFoldedSettings] = useState(true);
  const [custom, setCustom] = useState<{ label: string; cmd: string; error: string } | null>(null);
  const [asking, setAsking] = useState<Recipe | null>(null);
  const [saved, setSaved] = useState<Recipe[]>([]);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [cuHere, setCuHere] = useState(false);
  const cmds = useCommands(root);
  const pins = usePins(root);
  const full = pins.length >= MAX_COMMAND_PINS;

  // Read when the popover opens (it is only mounted while open): a saved
  // command edited in Settings, a worktree cut since, ClickUp connected.
  useEffect(() => {
    let live = true;
    void api.gitRepos().then(({ repos: r }) => { if (live) setRepos(r); }).catch(() => {});
    void clickupSetup().then((c) => { if (live) setCuHere(c.connected); });
    const stop = retryLoad(() => api.recipes(root).then((r) => { if (live) setSaved(r.recipes); return true; }).catch(() => false));
    return () => { live = false; stop(); };
  }, [root]);

  const q = query.trim().toLowerCase();
  const recipeCmds: Cmd[] = useMemo(() => saved
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q))
    .map((r) => ({
      name: r.name, cmd: `${RECIPE}${r.id}`, dir: "", recipe: r,
      desc: r.desc || `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}${r.params?.length ? " · needs values" : ""}`,
    })), [saved, q]);
  const groups: [string, Cmd[]][] = [];
  if (recipeCmds.length) groups.push(["Yours", recipeCmds]);
  if (cmds) {
    for (const [dir, list] of groupByDir(matchCommands(cmds.make, query))) groups.push([`make · ${dir ? `${dir}/Makefile` : "Makefile"}`, list]);
    for (const [dir, list] of groupByDir(matchCommands(cmds.scripts, query))) groups.push([`scripts · ${dir ? `${dir}/package.json` : "package.json"}`, list]);
  }
  const git = matchCommands(GIT_COMMANDS, query);
  const pages = (cuHere ? SETTINGS_PAGES : SETTINGS_PAGES.filter((p) => p.id !== "clickup")).filter((p) => !q || p.label.toLowerCase().includes(q));
  const rows = q ? searchSettings(q, SETTINGS_NO_KW).filter((r) => r.row && (cuHere || r.pane !== "clickup")) : [];
  const settingsShown = settingsOpen(foldedSettings, query, pages.length + rows.length);
  const pinned = pinRows(pins, saved, decodeCustomPin).filter((r) => !q || r.label.toLowerCase().includes(q));

  const finish = () => done();
  const run = (cmd: string) => { finish(); onRun(cmd); };
  const runRecipe = (r: Recipe) => {
    // Values wanted, or a plain-shell saved command with the shell inside tmux:
    // the form opens here with the reason, instead of typing into a program.
    if (r.params?.length || (!r.tmux && runTargetInTmux)) { setAsking(r); return; }
    if (r.tmux) { runRecipeSteps(root, r.steps, true); finish(); return; }
    finish();
    for (const step of r.steps) onRun(step);
  };
  const runRow = (c: Cmd) => (c.recipe ? runRecipe(c.recipe) : run(c.cmd));
  const runPinned = (value: string, recipeId?: string) => {
    const r = recipeId ? saved.find((x) => x.id === recipeId) : undefined;
    if (r) { runRecipe(r); return; }
    run(decodeCustomPin(value)?.cmd ?? value);
  };
  const saveCustom = () => {
    if (!custom) return;
    if (!custom.label.trim() || !custom.cmd.trim()) { setCustom({ ...custom, error: "Add both a label and the command to run." }); return; }
    if (!addCustomPin(root, custom.label, custom.cmd)) { setCustom({ ...custom, error: `You already have ${MAX_COMMAND_PINS} pinned commands. Unpin one first.` }); return; }
    setCustom(null);
  };

  if (asking) {
    return (
      <div className="p-2" style={{ width: WIDTH - 8 }}>
        <RunDialog r={asking} repos={repos} onRunStep={onRun} targetInTmux={runTargetInTmux} onClose={finish} onNote={finish} />
      </div>
    );
  }

  const star = (c: { value: string; label: string }, on: boolean) => (
    <button type="button" role="menuitem" aria-pressed={on} disabled={!on && full}
      onClick={() => togglePin(root, c.value)}
      aria-label={on ? `Unpin ${c.label}` : `Pin ${c.label}`}
      title={on ? "Unpin" : full ? `${MAX_COMMAND_PINS} pinned already. Unpin one first.` : `Pin ${c.label}`}
      className={`shrink-0 grid place-items-center rounded-md agx-mi ${on ? "" : "opacity-0 group-hover/cr:opacity-100 focus-visible:opacity-100"}`}
      style={{ width: 24, height: 24, color: on ? "var(--warning)" : "var(--text3)", ...(!on && full ? { opacity: 0.3 } : null) }}>
      <StarIcon size={ICON.xs} filled={on} />
    </button>
  );
  const cmdRow = (key: string, label: ReactNode, sub: string | undefined, title: string, value: string, on: boolean, runIt: () => void, mono: boolean) => (
    <div key={key} className="group/cr flex items-center gap-1 pr-1 rounded-md agx-mi" style={{ minHeight: 28 }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={runIt} title={title}
        className="min-w-0 flex-1 text-left flex items-baseline gap-2.5 px-2.5 py-1 text-[11px]">
        <span className="shrink-0 font-medium" style={{ color: "var(--primary-ink)", fontFamily: mono ? font : undefined }}>{label}</span>
        {sub && <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text3)" }}>{sub}</span>}
      </button>
      {star({ value, label: typeof label === "string" ? label : title }, on)}
    </div>
  );

  const nothing = !pinned.length && !groups.length && !git.length && !pages.length && !rows.length && !showScrollbackRow(query);
  return (
    <div style={{ width: WIDTH - 8 }} className="flex flex-col">
      <div className="p-1 pb-0.5 relative">
        <span className="flex absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter commands" aria-label="Filter commands" spellCheck={false} autoComplete="off" className={`w-full ${INPUT} pl-8`} style={INPUT_STYLE} />
      </div>

      {showScrollbackRow(query) && (
        <MenuRow icon={<SearchIcon size={ICON.sm} />} kbd="Ctrl+Shift+F" onClick={() => { finish(); onFind(); }}>Search the scrollback</MenuRow>
      )}

      {!q || pinned.length > 0 ? (
        <>
          <div className={`${GROUP_HEADING} flex items-center`} style={{ color: "var(--text3)" }}>
            Pinned<span className="ml-auto normal-case tracking-normal tabular-nums">{pinCounter(pins.length, MAX_COMMAND_PINS)}</span>
          </div>
          {pinned.map((r) => cmdRow("p:" + r.value, r.label, undefined, r.title, r.value, true, () => runPinned(r.value, r.recipeId), !r.recipeId && !decodeCustomPin(r.value)))}
          {showPinHole(pins.length) && !q && (
            <div className="mx-1 my-0.5 px-2.5 py-1.5 rounded-md text-[10.5px]" style={{ color: "var(--text3)", border: "1px dashed var(--surface-line)" }}>
              <StarIcon size={ICON.xs} className="inline-block align-[-2px] mr-1.5" />Pin up to {MAX_COMMAND_PINS} commands here with the star on any row.
            </div>
          )}
        </>
      ) : null}

      {groups.map(([label, list]) => (
        <div key={label}>
          <div className={GROUP_HEADING} style={{ color: "var(--text3)" }}>{label}</div>
          {list.map((c) => cmdRow(label + ":" + c.cmd, c.recipe ? c.recipe.name : c.cmd, c.desc || undefined,
            c.recipe ? c.recipe.steps.join("\n") : c.cmd, c.cmd, pins.includes(c.cmd), () => runRow(c), !c.recipe))}
        </div>
      ))}

      {git.length > 0 && (
        <div>
          <div className={GROUP_HEADING} style={{ color: "var(--text3)" }}>Git</div>
          {git.map((c) => cmdRow("g:" + c.cmd, c.cmd, c.desc, c.cmd, c.cmd, pins.includes(c.cmd), () => runRow(c), true))}
        </div>
      )}

      {(pages.length > 0 || rows.length > 0) && (
        <div>
          <button type="button" role="menuitem" aria-expanded={settingsShown} onClick={() => setFoldedSettings(settingsShown)}
            className={`${GROUP_HEADING} w-full flex items-center gap-1 text-left`} style={{ color: "var(--text3)" }}>
            <span style={{ display: "inline-flex", transform: settingsShown ? undefined : "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
            Settings
            <span className="ml-auto normal-case tracking-normal tabular-nums">{pages.length + rows.length}</span>
          </button>
          {settingsShown && pages.map((p) => (
            <MenuRow key={"sp:" + p.id} onClick={() => { finish(); openSettings(p.id); }}>Settings: {p.label}</MenuRow>
          ))}
          {settingsShown && rows.map((r) => (
            <MenuRow key={"sr:" + r.pane + ":" + r.row} onClick={() => { finish(); openSettings(r.pane, r.row); }}>
              Settings: {SETTINGS_PAGES.find((p) => p.id === r.pane)?.label ?? r.pane} › {r.label}
            </MenuRow>
          ))}
        </div>
      )}

      {nothing && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>{cmds ? `No command matches “${query.trim()}”` : "Reading the project…"}</div>}

      <div className="mt-1 pt-1 px-1 pb-1" style={{ borderTop: "1px solid var(--surface-line)" }}>
        <button type="button" role="menuitem" disabled={full} onClick={() => setCustom(custom ? null : { label: "", cmd: "", error: "" })}
          className="text-[10.5px] px-2 py-1 rounded-md"
          style={{ color: full ? "var(--text3)" : "var(--primary-ink)", border: "1px dashed color-mix(in srgb, var(--primary) 35%, transparent)", opacity: full ? 0.55 : 1 }}>
          <PlusIcon size={ICON.xs} className="inline-block align-[-2px] mr-1" />Pin a custom command{full ? " (limit reached)" : ""}
        </button>
        {custom && !full && (
          <form onSubmit={(e) => { e.preventDefault(); saveCustom(); }} className="mt-1.5 grid grid-cols-[92px_minmax(0,1fr)_auto] gap-1.5 items-center">
            <FilterField value={custom.label} onChange={(v) => setCustom({ ...custom, label: v })} placeholder="label" label="Custom command label" className="min-w-0" />
            <FilterField value={custom.cmd} onChange={(v) => setCustom({ ...custom, cmd: v })} placeholder="command, e.g. clear" label="Custom command" className="min-w-0" />
            <Button size="compact" tone="primary" type="submit">Pin</Button>
            {custom.error && <span className="col-span-3 text-[10px]" style={{ color: "var(--error-ink)" }}>{custom.error}</span>}
          </form>
        )}
      </div>
    </div>
  );
}
