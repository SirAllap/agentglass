// The project-commands control, shared by both terminals.
//
// There are two shells in this app — the terminal view and the console docked
// under Docker's logs — and they were not equals. The full view had a repo
// picker and a searchable list of every Makefile target and package script;
// the console, which is where migrations and container shells actually get
// run, had nothing but a prompt. Same shell, same PTY, same session store,
// half the affordances, because the controls were written inline in one panel's
// JSX and could not be reached from the other.
//
// So the control lives here now and both mount the same one. The row it draws
// is: the commands dropdown, then whatever the user has pinned.
//
// Pins are what make this more than a menu. A menu of 316 commands answers
// "what can I run"; a pinned chip answers "run the thing I run twenty times a
// day", which for a Django project is one migrate and one shell. Five is the
// cap — enough for a day's work, few enough that the row can never grow into
// the second scrolling strip this was meant to replace.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ContextMenu } from "./ContextMenu.tsx";
import { RunDialog, runRecipeSteps } from "./RecipesPane.tsx";
import type { GitRepoRef } from "../../../shared/types.ts";
import { openSettings } from "../lib/openSettings.ts";
import type { Recipe } from "../../../shared/types.ts";
import type { ProjectCommand, TerminalCommands } from "../../../shared/types.ts";
import { api, IS_DEMO } from "../lib/api.ts";
import { retryLoad } from "../lib/retryLoad.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { keepTermFocus } from "../lib/keepFocus.ts";
import { CloseButton } from "./CloseButton.tsx";

/**
 * The four git one-liners this row used to hardcode as always-visible chips.
 *
 * They were a fixed 260px of the toolbar that nobody could remove, on a row
 * that also has to hold a repo picker and a commands button. Now they are
 * simply the first group in the dropdown — still one click away, pinnable like
 * anything else, and costing nothing when you don't want them.
 */
export const GIT_COMMANDS: ProjectCommand[] = [
  { name: "status", cmd: "git status", desc: "What is changed, staged and untracked", dir: "" },
  { name: "log", cmd: "git log --oneline -15", desc: "The last 15 commits, one line each", dir: "" },
  { name: "diff", cmd: "git diff --stat", desc: "Which files changed, and by how much", dir: "" },
  { name: "branches", cmd: "git branch -vv", desc: "Local branches with their upstreams", dir: "" },
];

// --- pins --------------------------------------------------------------------

export const RECIPE = "recipe:";
const MAX_PINS = 5;
const PIN_KEY = "agentglass.commandPins";
const CUSTOM_PIN = "custom:";

/** A command the person typed themselves, rather than one discovered in the repo. */
export type CustomPin = { label: string; cmd: string };

/**
 * Keep the old string[] storage format while giving custom pins their own
 * display label. Existing command and recipe pins therefore survive the
 * upgrade untouched, and a label containing spaces or punctuation is safe in
 * localStorage too.
 */
export function encodeCustomPin(label: string, cmd: string): string {
  const name = label.trim();
  const command = cmd.trim();
  if (!name || !command) return "";
  return `${CUSTOM_PIN}${encodeURIComponent(JSON.stringify({ label: name, cmd: command }))}`;
}

export function decodeCustomPin(value: string): CustomPin | null {
  if (!value.startsWith(CUSTOM_PIN)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(CUSTOM_PIN.length))) as Partial<CustomPin>;
    if (typeof parsed.label !== "string" || typeof parsed.cmd !== "string") return null;
    const label = parsed.label.trim();
    const cmd = parsed.cmd.trim();
    return label && cmd ? { label, cmd } : null;
  } catch {
    return null;
  }
}

export function addCustomPin(root: string, label: string, cmd: string): boolean {
  const encoded = encodeCustomPin(label, cmd);
  if (!encoded || !root) return false;
  const cur = pinned[root] ?? EMPTY;
  if (cur.includes(encoded)) return true;
  if (cur.length >= MAX_PINS) return false;
  write({ ...pinned, [root]: [...cur, encoded] });
  return true;
}

/**
 * Pins are per repo, not global.
 *
 * A machine with seventeen checkouts of one project and a dozen other projects
 * has no single set of five commands that is right everywhere — `make migrate`
 * belongs to the Django repo and means nothing in the next one. Keyed by repo
 * root, both terminals pointed at the same repo therefore show the same pins,
 * which is the point: it is one setting, not one per panel.
 */
type PinMap = Record<string, string[]>;
const EMPTY: string[] = [];

function read(): PinMap {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PinMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v.filter((c): c is string => typeof c === "string").slice(0, MAX_PINS);
    }
    return out;
  } catch { return {}; }
}

let pinned: PinMap = read();
const subs = new Set<() => void>();

function write(next: PinMap) {
  pinned = next;
  try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* private mode — pins last the session */ }
  for (const s of subs) s();
}

/** Pin, or unpin if it is already there. Returns false when the cap refused it,
 *  so the caller can say why rather than looking broken. */
export function togglePin(root: string, cmd: string): boolean {
  if (!root || !cmd) return false;
  const cur = pinned[root] ?? EMPTY;
  if (cur.includes(cmd)) {
    write({ ...pinned, [root]: cur.filter((c) => c !== cmd) });
    return true;
  }
  if (cur.length >= MAX_PINS) return false;
  write({ ...pinned, [root]: [...cur, cmd] });
  return true;
}

/**
 * The pins for one repo, live in every mounted bar at once.
 *
 * Both terminals can be on screen together — the Docker console under the logs
 * while the terminal view holds the same repo — and pinning in one has to show
 * up in the other immediately, or the two disagree about a setting they share.
 * The snapshot is the stored array itself, which `write` replaces rather than
 * mutates, so the identity check inside useSyncExternalStore stays honest.
 */
export function usePins(root: string): string[] {
  return useSyncExternalStore(
    useCallback((cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; }, []),
    useCallback(() => pinned[root] ?? EMPTY, [root]),
    useCallback(() => EMPTY, []),
  );
}

// --- the command list --------------------------------------------------------

/**
 * One fetch per repo, shared by every bar showing it.
 *
 * Two bars mounted on the same repo asked the server the same question twice,
 * and that question walks the project for Makefiles and package.json files.
 * Held briefly rather than forever: a Makefile does change, just not on the
 * timescale of switching panels.
 */
const CMD_TTL_MS = 30_000;
const cmdCache = new Map<string, { at: number; data: TerminalCommands }>();
const cmdInflight = new Map<string, Promise<TerminalCommands>>();

export function loadCommands(root: string): Promise<TerminalCommands> {
  const hit = cmdCache.get(root);
  if (hit && Date.now() - hit.at < CMD_TTL_MS) return Promise.resolve(hit.data);
  const flying = cmdInflight.get(root);
  if (flying) return flying;
  const p = api.terminalCommands(root)
    .then((data) => { cmdCache.set(root, { at: Date.now(), data }); return data; })
    .catch(() => ({ enabled: true, make: [], scripts: [] } as TerminalCommands))
    .finally(() => { cmdInflight.delete(root); });
  cmdInflight.set(root, p);
  return p;
}

export function useCommands(root: string): TerminalCommands | null {
  const [cmds, setCmds] = useState<TerminalCommands | null>(null);
  useEffect(() => {
    if (!root || IS_DEMO) { setCmds(null); return; }
    let live = true;
    setCmds(null);
    loadCommands(root).then((c) => { if (live) setCmds(c); });
    return () => { live = false; };
  }, [root]);
  return cmds;
}

/**
 * Filter the command list by name, description or folder.
 *
 * Description included deliberately: a Makefile names things like `infra.up`
 * and `check.build_id`, so what you remember is usually what it *does*, not
 * what it is called.
 */
export function matchCommands(list: ProjectCommand[], query: string): ProjectCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => `${c.name} ${c.desc ?? ""} ${c.dir ?? ""}`.toLowerCase().includes(q));
}

/** Bucket commands by the project folder they belong to, repo root first. */
export function groupByDir(list: ProjectCommand[]): [string, ProjectCommand[]][] {
  const by = new Map<string, ProjectCommand[]>();
  for (const c of list) {
    const dir = c.dir ?? "";
    if (!by.has(dir)) by.set(dir, []);
    by.get(dir)!.push(c);
  }
  return [...by.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

/**
 * One row in the dropdown.
 *
 * A div rather than a button, because it holds two: running the command and
 * pinning it are different actions and a button inside a button is not
 * something a browser will lay out twice the same way.
 */
function CommandRow({ c, font, on, full, onRun, onPin }: {
  c: ProjectCommand & { recipe?: Recipe }; font: string; on: boolean; full: boolean;
  onRun: (cmd: string) => void; onPin: (cmd: string) => void;
}) {
  const r = c.recipe;
  return (
    <div className="group w-full px-3 py-1.5 flex items-baseline gap-2.5 hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]">
      <button onClick={() => onRun(c.cmd)} title={r ? r.steps.join("\n") : c.cmd} className="min-w-0 flex-1 text-left flex items-baseline gap-2.5">
        <span className="shrink-0 font-medium" style={{ color: "var(--primary-hover)", fontFamily: font }}>{r ? r.name : c.cmd}</span>
        <span className="min-w-0 flex-1 truncate t-dim2">{c.desc || "—"}</span>
        {/* Marked, because a saved command and a found one behave differently:
            one is a line, the other can be four and can ask you a question. */}
        {r && <span className="shrink-0 text-[10px] px-1 rounded" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>{r.params?.length ? "asks" : "yours"}</span>}
      </button>
      {/* Pinned stars stay lit; the rest appear on hover, so a list of 300 rows
          is not 300 competing controls. */}
      <button
        onClick={(e) => { e.stopPropagation(); onPin(c.cmd); }}
        disabled={!on && full}
        // A real target, not a glyph. At 11px in a 1px gutter this was a dot
        // you aimed at and missed; 22px square is a thing you press.
        className={`shrink-0 text-[14px] leading-none rounded flex items-center justify-center hover:bg-white/10 ${on ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        style={{ width: 22, height: 22, color: on ? "var(--warning)" : "var(--text3)", opacity: !on && full ? 0.3 : undefined }}
        title={on ? "Unpin" : full ? `${MAX_PINS} pinned already — unpin one first` : `Pin ${r ? r.name : c.cmd} to the bar`}
      >{on ? "★" : "☆"}</button>
    </div>
  );
}

/**
 * The commands dropdown and the pinned chips.
 *
 * `font` is the terminal's own face: a command is a thing you type, and it
 * reads as one when it is set in the face it will be typed in.
 */
export function CommandBar({ root, disabled, font, onRun, runTargetInTmux, onClose, dropUp, quiet }: {
  root: string;
  disabled: boolean;
  font: string;
  onRun: (cmd: string) => void;
  /** Whether the shell THIS bar drives (the focused pane, or the console for the
   *  strip) is inside tmux. A recipe that wants a plain shell will not type into
   *  it while it is — the line would land in the pane's program, not a prompt. */
  runTargetInTmux?: boolean;
  /** Put the cursor back where it belongs once the dropdown closes.
   *
   *  The filter input has to take focus off the terminal while it is open (you
   *  came here to type in it), so closing it — by Escape, an outside click, or
   *  the toggle — has to hand the focus back, or the shell sits there ignoring
   *  keys until you click into it again. Running a command already refocuses
   *  through `onRun`; this covers every other way out. */
  onClose?: () => void;
  /** Open upwards — for the console strip, which sits at the bottom of a panel
   *  and has nothing below it to open into. */
  dropUp?: boolean;
  /**
   * In the background: no count, no colour, no pinned strip.
   *
   * The terminal's bar wears this one. Commands is used from the Docker console
   * far more than from the terminal — his words — and the count it carried
   * ("(331)", or "(none)") is the number that helps least when choosing: the
   * dropdown has a filter for exactly that. The pinned strip goes with it,
   * because an empty one sat there inviting a pin nobody wanted.
   */
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [customCmd, setCustomCmd] = useState("");
  const [customError, setCustomError] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const cmds = useCommands(root);
  /* Your own, alongside the ones we found. Fetched here rather than threaded in
     because this menu is where "what can I run here" is answered, and a saved
     command is an answer to exactly that question. */
  const [saved, setSaved] = useState<Recipe[]>([]);
  /*
   * The recipe that is asking for values, shown INSIDE the dropdown.
   *
   * The first version sent you to Settings for this, on the grounds that asking
   * inside a menu would be a dialog within a menu. That was a rationalisation
   * of a shortcut: pressing a command in the place you go to run commands and
   * being taken to a settings page instead is the wrong answer however it is
   * justified. The menu simply shows the form instead of the list — it is not a
   * second surface, it is this one showing the next thing.
   */
  const [asking, setAsking] = useState<Recipe | null>(null);
  /** A pinned chip's own form, anchored to the chip rather than to the menu. */
  const [chip, setChip] = useState<{ r: Recipe; x: number; y: number } | null>(null);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  useEffect(() => { void api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {}); }, []);
  /*
   * Re-read every time the menu OPENS, not once when it mounts.
   *
   * Editing a recipe in Settings left this list holding the copy from before —
   * so the form asked for a parameter that had been deleted, while the preview
   * beside it, which comes from the server, showed the new steps. One dialog
   * disagreeing with itself.
   *
   * The repo picker in this app already re-reads on open for the same reason
   * (a worktree cut after mount never appeared). Cheap, and the only way a
   * change made elsewhere shows up without restarting the app.
   */
  const pins = usePins(root);
  useEffect(() => {
    // Also when a pin points at one: the chips are on the bar whether or not
    // the menu has ever been opened, and a chip that cannot resolve its recipe
    // would type `recipe:<id>` at the shell as if it were a command.
    if (!root || !(open || pins.some((c) => c.startsWith(RECIPE)))) return;
    let gone = false;
    // Retried, because at startup this fetch loses a race it cannot see. The
    // window is up before the sidecar is listening — index.html's splash waits
    // on exactly that — so the first read fails, and the old `.catch(() => {})`
    // made the failure permanent: the chips sat there reading
    // `recipe:rmsh8muud0` until somebody opened the menu, which re-ran this by
    // accident and fixed it. Bounded: a few seconds, then it gives up.
    const stop = retryLoad(() => api.recipes(root)
      .then((r) => { if (!gone) setSaved(r.recipes); return true; })
      .catch(() => false));
    return () => { gone = true; stop(); };
  }, [root, open, pins]);
  /* Every way out closes the FORM too, not just the menu around it. Without
     this, dismissing the dropdown left `asking` set: the next time it opened —
     after switching branch, after anything — it came back showing a half-filled
     form for a command you had walked away from. */
  const dismiss = useCallback(() => {
    setOpen(false); setQuery(""); setAsking(null); setCustomOpen(false); setCustomError(""); onClose?.();
  }, [onClose]);
  useDismiss(open, wrap, dismiss);

  const n = (cmds?.make.length ?? 0) + (cmds?.scripts.length ?? 0);
  const full = pins.length >= MAX_PINS;
  // Selecting a command hands focus back through onRun (it types into the
  // shell), so it closes without going through `dismiss`'s own refocus.
  const run = (cmd: string) => { setOpen(false); setQuery(""); setAsking(null); onRun(cmd); };
  const saveCustom = () => {
    if (!customLabel.trim() || !customCmd.trim()) {
      setCustomError("Add both a chip label and the command to run.");
      return;
    }
    if (!addCustomPin(root, customLabel, customCmd)) {
      setCustomError(`You already have ${MAX_PINS} pinned commands — unpin one first.`);
      return;
    }
    setCustomLabel("");
    setCustomCmd("");
    setCustomError("");
    setCustomOpen(false);
  };
  /*
   * A saved command, from the menu.
   *
   * With nothing to fill in, its steps are typed in order — the same thing the
   * run dialog does, because it is the same console. With parameters it cannot
   * run from here: it needs values, and asking for them inside a dropdown would
   * be a dialog within a menu. It opens the editor, where the dialog with its
   * preview already lives.
   */
  const runRecipe = (r: Recipe) => {
    if (r.params?.length) { setAsking(r); return; }
    // "Run inside tmux" goes to the app's persistent wrapper in the docked
    // console. Everything else runs in the shell THIS bar drives — the one on
    // screen — through `onRun`. But a plain-shell recipe will not type into that
    // shell once it is in tmux (the line would land in the pane's program), so
    // open the form with the reason instead of firing into nothing.
    if (r.tmux) { runRecipeSteps(root, r.steps, true); setOpen(false); setQuery(""); setAsking(null); return; }
    if (runTargetInTmux) { setAsking(r); return; }
    setOpen(false); setQuery(""); setAsking(null);
    for (const step of r.steps) onRun(step);
  };
  const pin = (cmd: string) => { togglePin(root, cmd); };
  /** A pinned chip is either a command line or a recipe id. Resolved here so
   *  the bar shows a name rather than `recipe:r1k2…`, and so a pin survives the
   *  recipe being edited — the id does not change, the steps do. */
  const recipeOf = (cmd: string): Recipe | undefined =>
    cmd.startsWith(RECIPE) ? saved.find((r) => r.id === cmd.slice(RECIPE.length)) : undefined;
  /*
   * A pinned chip opens its own form, under itself.
   *
   * It used to open the whole commands dropdown with the form inside — three
   * hundred rows unfurling over the screen to ask for one value, anchored
   * nowhere near the thing pressed. The chip is on the bar precisely so it can
   * be used without the menu; sending you through the menu undid that.
   *
   * `ContextMenu` already knows how to sit at a point, keep itself on screen,
   * close on Escape and on a click elsewhere. Same component the rail and the
   * board pills use.
   */
  const pinned = (cmd: string, at: DOMRect) => {
    const r = recipeOf(cmd);
    if (r) {
      // Fire on one press only when it can actually run: nothing to fill in, not
      // marked "ask first", and — for a plain-shell recipe — the shell this bar
      // drives is not already inside tmux. Otherwise open the form, which is
      // where the values, the confirm, or the "shell is in tmux" reason live.
      const wontRun = !r.tmux && !!runTargetInTmux;
      if (!r.params?.length && !r.confirm && !wontRun) { runRecipe(r); return; }
      setChip({ r, x: at.left, y: at.top });
      return;
    }
    onRun(decodeCustomPin(cmd)?.cmd ?? cmd);
  };

  const groups: [string, ProjectCommand[]][] = [];
  /*
   * Recipes first, because they are the ones somebody chose to keep — and there
   * are four of them against three hundred that were found.
   *
   * One with parameters asks for them here, in the menu itself: the list is
   * replaced by the same form and preview the editor uses. One with nothing to
   * fill in just runs, step by step, in order.
   */
  const mine = saved.filter((r) => {
    const q = query.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q);
  });
  if (mine.length) {
    groups.push(["yours", mine.map((r) => ({
      name: r.name,
      // Pinned by id, never by its lines: a recipe that asks for values has no
      // single command to pin, and one that does not would pin a multi-line
      // string that the bar cannot show or re-identify after an edit.
      cmd: `${RECIPE}${r.id}`,
      desc: r.desc || `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}${r.params?.length ? " · needs values" : ""}`,
      dir: "",
      recipe: r,
    }))]);
  }
  if (cmds) {
    for (const [dir, list] of groupByDir(matchCommands(cmds.make, query))) groups.push([`make — ${dir ? `${dir}/Makefile` : "Makefile"}`, list]);
    for (const [dir, list] of groupByDir(matchCommands(cmds.scripts, query))) groups.push([`scripts — ${dir ? `${dir}/package.json` : "package.json"}`, list]);
  }
  const gitMatches = matchCommands(GIT_COMMANDS, query);

  return (
    <>
      {/* Anchored to the chip, above the bar. Rendered outside the dropdown so
          it does not need the dropdown open to exist. */}
      {chip && (
        <ContextMenu x={chip.x} y={chip.y} onClose={() => setChip(null)}>
          <div className="p-1" style={{ minWidth: 300 }}>
            <RunDialog r={chip.r} repos={repos} onRunStep={onRun} targetInTmux={runTargetInTmux}
              onClose={() => setChip(null)} onNote={() => setChip(null)} />
          </div>
        </ContextMenu>
      )}
      <div className="relative shrink-0" ref={wrap}>
        {/* onMouseDown keeps the shell's cursor: the trigger is a button, and a
            press on it would otherwise blur the terminal. Opening reveals the
            filter input, which autofocuses on its own; closing routes through
            `dismiss` so the focus goes back to the shell rather than nowhere. */}
        <button onMouseDown={keepTermFocus} onClick={() => (open ? dismiss() : setOpen(true))} disabled={!root || IS_DEMO}
          title="Ready-to-run project commands: Makefile targets & package scripts, with what each one does. Pin the ones you use."
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg whitespace-nowrap"
          style={quiet
            ? { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", opacity: root && !IS_DEMO ? 1 : 0.5 }
            : { color: n ? "var(--primary-hover)" : "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", fontWeight: 500, opacity: root && !IS_DEMO ? 1 : 0.5 }}>
          ⚙ Commands{quiet ? "" : n ? ` (${n})` : cmds ? " (none)" : " …"}<span className="t-dim2">▼</span>
        </button>
        {open && (
          // keepTermFocus on the whole popover: a click on its padding, a
          // border, or a command row must not blur the filter input (it stays
          // yours to type in while the menu is open). The input itself is
          // excluded by the handler, so it can still be clicked into.
          <div onMouseDown={keepTermFocus} className="absolute left-0 rounded-lg text-[11px] shadow-2xl flex flex-col"
            style={{ zIndex: 40, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", width: 460, maxHeight: 420, overflow: "hidden", ...(dropUp ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }) }}>
            {/* A real project has more targets than fit on a screen — the repo
                this was built against has 316 — so scrolling to find `migrate`
                was the only way to run it. Matches the name and what the target
                says it does, since half of them are only recognisable by their
                description. */}
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="filter commands…"
              className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
            <div className="px-2 pb-1.5 shrink-0">
              <button type="button" onClick={() => { setCustomOpen((v) => !v); setCustomError(""); }} disabled={full}
                className="text-[10.5px] px-2 py-1 rounded-md"
                style={{ color: full ? "var(--text3)" : "var(--primary-hover)", border: "1px dashed color-mix(in srgb, var(--primary) 35%, transparent)", opacity: full ? 0.55 : 1 }}>
                ＋ Pin a custom command{full ? " (limit reached)" : ""}
              </button>
              {customOpen && !full && (
                <form onSubmit={(e) => { e.preventDefault(); saveCustom(); }} className="mt-1.5 grid grid-cols-[92px_minmax(0,1fr)_auto] gap-1.5 items-center">
                  <input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} autoFocus placeholder="chip label"
                    aria-label="Custom command chip label" className="px-2 py-1 rounded outline-none min-w-0"
                    style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                  <input value={customCmd} onChange={(e) => setCustomCmd(e.target.value)} placeholder="command, e.g. clear"
                    aria-label="Custom command" className="px-2 py-1 rounded outline-none min-w-0"
                    style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                  <button type="submit" className="px-2 py-1 rounded" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)" }}>Pin</button>
                  {customError && <span className="col-span-3 text-[10px]" style={{ color: "var(--error)" }}>{customError}</span>}
                </form>
              )}
            </div>
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1" style={{ minHeight: 0 }}>
              {!!gitMatches.length && (
                <div>
                  <div className="px-3 pt-1.5 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">git — always available</div>
                  {gitMatches.map((c) => <CommandRow key={"g:" + c.cmd} c={c} font={font} on={pins.includes(c.cmd)} full={full} onRun={(cmd) => { const rr = (c as ProjectCommand & { recipe?: Recipe }).recipe; if (rr) runRecipe(rr); else run(cmd); }} onPin={pin} />)}
                </div>
              )}
              {/* The form takes the whole menu while it is up: you came here to
                  run this one, and a list of three hundred others underneath is
                  only somewhere to lose your place. */}
              {asking ? (
                <div className="px-2 py-2">
                  <RunDialog r={asking} repos={repos} onRunStep={onRun} targetInTmux={runTargetInTmux}
                    onClose={() => { setAsking(null); setOpen(false); setQuery(""); }}
                    onNote={() => { setAsking(null); setOpen(false); setQuery(""); }} />
                </div>
              ) : groups.map(([label, list]) => (
                <div key={label}>
                  <div className="px-3 pt-2 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">{label}</div>
                  {list.map((c) => <CommandRow key={label + ":" + c.cmd} c={c} font={font} on={pins.includes(c.cmd)} full={full} onRun={(cmd) => { const rr = (c as ProjectCommand & { recipe?: Recipe }).recipe; if (rr) runRecipe(rr); else run(cmd); }} onPin={pin} />)}
                </div>
              ))}
              {!asking && !gitMatches.length && !groups.length && (
                <div className="px-3 py-2 t-dim2">{cmds ? `No command matches “${query.trim()}”` : "Reading the project…"}</div>
              )}
            </div>
            <div className="shrink-0 px-3 py-1.5 t-dim2 text-[10.5px] border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
              ☆ Pins a command to the bar — {pins.length} of {MAX_PINS} used, per repo
            </div>
          </div>
        )}
      </div>

      {/* The pinned row. Empty until something is pinned, and it says so once —
          a bar with no affordance is a bar nobody discovers.

          It does not scroll, deliberately. `overflow-x-auto` spent 7px of a
          48px bar on a scrollbar and — being an overflow container — cropped
          the unpin button, which used to hang outside its chip on a negative
          offset. The row is capped at MAX_PINS, so a crowded bar is a
          truncation problem rather than a scrolling one: chips shrink, the
          label ellipses, and the full command stays in the tooltip. */}
      <div className="flex items-center gap-1 min-w-0 overflow-hidden" style={quiet ? { display: "none" } : undefined}>
        {pins.map((cmd) => (
          <span key={cmd} className="group flex items-center min-w-0 rounded-md"
            style={{ border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
            {/* onMouseDown keeps the shell focused; running the chip refocuses
                it anyway through onRun, but unpinning does not, so both carry
                the guard rather than only one. */}
            <button onMouseDown={keepTermFocus} onClick={(e) => pinned(cmd, e.currentTarget.getBoundingClientRect())} disabled={disabled || !root || IS_DEMO}
              className="text-[10px] pl-2 pr-1 py-1 min-w-0 truncate"
              style={{ color: "var(--text2)", fontFamily: font, maxWidth: 180 }}
              title={decodeCustomPin(cmd) ? `Run ${decodeCustomPin(cmd)!.cmd}` : recipeOf(cmd) ? `Run ${recipeOf(cmd)!.name}` : `Run ${cmd}`}>{decodeCustomPin(cmd)?.label ?? recipeOf(cmd)?.name ?? cmd}</button>
            {/* Unpin from inside the chip, in room the padding already holds:
                hidden rather than absent, so revealing it cannot re-flow the
                row and nothing can clip it. Going back to the dropdown to find
                the row you pinned is the long way round. */}
            <CloseButton onMouseDown={keepTermFocus} onClick={() => togglePin(root, cmd)} style={{ color: "var(--text3)" }} title={`Unpin ${decodeCustomPin(cmd)?.label ?? cmd}`} className="shrink-0 w-[15px] pr-1 opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100" />
          </span>
        ))}
        {!pins.length && !!root && (
          // Opens the dropdown (whose input then autofocuses), so it must not
          // steal the shell's cursor on the way there — see the trigger above.
          <button onMouseDown={keepTermFocus} onClick={() => setOpen(true)} className="text-[10px] px-2 py-1 rounded-md whitespace-nowrap shrink-0"
            style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 30%, transparent)" }}
            title={`Pin up to ${MAX_PINS} commands here — they stay one click away, per repo`}>☆ Pin a command</button>
        )}
      </div>
    </>
  );
}
