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
import type { ProjectCommand, TerminalCommands } from "../../../shared/types.ts";
import { api, IS_DEMO } from "../lib/api.ts";
import { useDismiss } from "../lib/useDismiss.ts";

/**
 * The four git one-liners this row used to hardcode as always-visible chips.
 *
 * They were a fixed 260px of the toolbar that nobody could remove, on a row
 * that also has to hold a repo picker and a commands button. Now they are
 * simply the first group in the dropdown — still one click away, pinnable like
 * anything else, and costing nothing when you don't want them.
 */
export const GIT_COMMANDS: ProjectCommand[] = [
  { name: "status", cmd: "git status", desc: "what is changed, staged and untracked", dir: "" },
  { name: "log", cmd: "git log --oneline -15", desc: "the last 15 commits, one line each", dir: "" },
  { name: "diff", cmd: "git diff --stat", desc: "which files changed, and by how much", dir: "" },
  { name: "branches", cmd: "git branch -vv", desc: "local branches with their upstreams", dir: "" },
];

// --- pins --------------------------------------------------------------------

export const MAX_PINS = 5;
const PIN_KEY = "agentglass.commandPins";

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
  c: ProjectCommand; font: string; on: boolean; full: boolean;
  onRun: (cmd: string) => void; onPin: (cmd: string) => void;
}) {
  return (
    <div className="group w-full px-3 py-1.5 flex items-baseline gap-2.5 hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]">
      <button onClick={() => onRun(c.cmd)} title={c.cmd} className="min-w-0 flex-1 text-left flex items-baseline gap-2.5">
        <span className="shrink-0 font-medium" style={{ color: "var(--primary-hover)", fontFamily: font }}>{c.cmd}</span>
        <span className="min-w-0 flex-1 truncate t-dim2">{c.desc || "—"}</span>
      </button>
      {/* Pinned stars stay lit; the rest appear on hover, so a list of 300 rows
          is not 300 competing controls. */}
      <button
        onClick={(e) => { e.stopPropagation(); onPin(c.cmd); }}
        disabled={!on && full}
        className={`shrink-0 text-[11px] leading-none px-1 ${on ? "" : "opacity-0 group-hover:opacity-100"}`}
        style={{ color: on ? "var(--warning)" : "var(--text3)", opacity: !on && full ? 0.3 : undefined }}
        title={on ? "unpin" : full ? `${MAX_PINS} pinned already — unpin one first` : `pin ${c.cmd} to the bar`}
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
export function CommandBar({ root, disabled, font, onRun, dropUp }: {
  root: string;
  disabled: boolean;
  font: string;
  onRun: (cmd: string) => void;
  /** Open upwards — for the console strip, which sits at the bottom of a panel
   *  and has nothing below it to open into. */
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const cmds = useCommands(root);
  const pins = usePins(root);
  useDismiss(open, wrap, () => { setOpen(false); setQuery(""); });

  const n = (cmds?.make.length ?? 0) + (cmds?.scripts.length ?? 0);
  const full = pins.length >= MAX_PINS;
  const run = (cmd: string) => { setOpen(false); setQuery(""); onRun(cmd); };
  const pin = (cmd: string) => { togglePin(root, cmd); };

  const groups: [string, ProjectCommand[]][] = [];
  if (cmds) {
    for (const [dir, list] of groupByDir(matchCommands(cmds.make, query))) groups.push([`make — ${dir ? `${dir}/Makefile` : "Makefile"}`, list]);
    for (const [dir, list] of groupByDir(matchCommands(cmds.scripts, query))) groups.push([`scripts — ${dir ? `${dir}/package.json` : "package.json"}`, list]);
  }
  const gitMatches = matchCommands(GIT_COMMANDS, query);

  return (
    <>
      <div className="relative shrink-0" ref={wrap}>
        <button onClick={() => setOpen((o) => !o)} disabled={!root || IS_DEMO}
          title="Ready-to-run project commands: Makefile targets & package scripts, with what each one does. Pin the ones you use."
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg font-medium whitespace-nowrap"
          style={{ color: n ? "var(--primary-hover)" : "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: root && !IS_DEMO ? 1 : 0.5 }}>
          ⚙ commands{n ? ` (${n})` : cmds ? " (none)" : " …"}<span className="t-dim2">▼</span>
        </button>
        {open && (
          <div className="absolute left-0 rounded-lg text-[11px] shadow-2xl flex flex-col"
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
            <div className="agx-scroll overflow-y-auto py-1" style={{ minHeight: 0 }}>
              {!!gitMatches.length && (
                <div>
                  <div className="px-3 pt-1.5 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">git — always available</div>
                  {gitMatches.map((c) => <CommandRow key={"g:" + c.cmd} c={c} font={font} on={pins.includes(c.cmd)} full={full} onRun={run} onPin={pin} />)}
                </div>
              )}
              {groups.map(([label, list]) => (
                <div key={label}>
                  <div className="px-3 pt-2 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">{label}</div>
                  {list.map((c) => <CommandRow key={label + ":" + c.cmd} c={c} font={font} on={pins.includes(c.cmd)} full={full} onRun={run} onPin={pin} />)}
                </div>
              ))}
              {!gitMatches.length && !groups.length && (
                <div className="px-3 py-2 t-dim2">{cmds ? `no command matches “${query.trim()}”` : "reading the project…"}</div>
              )}
            </div>
            <div className="shrink-0 px-3 py-1.5 t-dim2 text-[9.5px] border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
              ☆ pins a command to the bar — {pins.length} of {MAX_PINS} used, per repo
            </div>
          </div>
        )}
      </div>

      {/* The pinned row. Empty until something is pinned, and it says so once —
          a bar with no affordance is a bar nobody discovers. */}
      <div className="flex items-center gap-1 min-w-0 overflow-x-auto agx-scroll">
        {pins.map((cmd) => (
          <span key={cmd} className="group relative flex items-center shrink-0">
            <button onClick={() => onRun(cmd)} disabled={disabled || !root || IS_DEMO}
              className="text-[10px] pl-2 pr-2 py-1 rounded-md whitespace-nowrap"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", fontFamily: font }}
              title={`run ${cmd}`}>{cmd}</button>
            {/* Unpin from the chip itself: going back to the dropdown to find
                the row you pinned is the long way round. */}
            <button onClick={() => togglePin(root, cmd)}
              className="absolute -top-1 -right-1 text-[9px] leading-none rounded-full px-[3px] py-[1px] opacity-0 group-hover:opacity-100"
              style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text3)" }}
              title={`unpin ${cmd}`}>✕</button>
          </span>
        ))}
        {!pins.length && !!root && (
          <button onClick={() => setOpen(true)} className="text-[10px] px-2 py-1 rounded-md whitespace-nowrap shrink-0"
            style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 30%, transparent)" }}
            title={`Pin up to ${MAX_PINS} commands here — they stay one click away, per repo`}>☆ pin a command</button>
        )}
      </div>
    </>
  );
}
