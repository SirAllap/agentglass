/*
 * A SCOUT'S PLAN, SAVED WHERE SOMEBODY CAN READ IT.
 *
 * A scout runs in plan mode: Write is closed, ExitPlanMode asks a person who is
 * not there, and Bash cannot write either. Its plan is the turn's last message
 * and nothing else, so a scout that answered "here is the plan" left it in a
 * file the seat had to be told about and a person had to go and read.
 *
 * When a scout's turn ends cleanly, this writes that message to PLAN_FILE in
 * the worker's own checkout — the directory the plan is about — and, when a
 * seat started it, sends the same text as a report, which is what
 * `agentglass-agent inbox` reads. The brief says so (`rolePrompt.ts` PLAN_NOTE),
 * so the scout writes its plan as its last message instead of trying to save a
 * file it cannot save.
 *
 * The plan is a file in somebody else's tree, so the checkout's own ignore file
 * is told about it first: `git status` must not show a scout's leftover, and a
 * reviewer diffing that tree must not read it as part of a change.
 *
 * Ceiling: a plan that a scout never wrote is not invented here. No text, no
 * file, no report — and `endedWithoutResult` says so for a role that owes one.
 * A failed turn writes nothing: its message is a failure, not a plan.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as AgentOps from "../agentops.ts";
import { git, projectRootOf } from "../git.ts";
import { PLAN_FILE, rolePlans } from "../rolePrompt.ts";
import { addReport } from "../seatreport.ts";
import { answerOf, runFiles } from "./headless.ts";
import { startedByOf } from "./workerstart.ts";

const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** The folder the plan lives in, as the ignore file spells it. */
const PLAN_DIR = PLAN_FILE.split("/")[0]!;

/**
 * Have this checkout ignore the plan's folder. `info/exclude` is local to the
 * clone and shared by its worktrees, so nothing is committed and nothing is
 * left untracked. A directory with no git is left alone — there is no status
 * for the file to appear in — and a failure here never costs the plan.
 */
function ignorePlanDir(cwd: string): void {
  try {
    const r = git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
    if (r.code !== 0) return;
    const named = r.stdout.trim();
    if (!named) return;
    const path = isAbsolute(named) ? named : join(cwd, named);
    const text = readText(path);
    if (text.split("\n").some((l) => l.trim() === `${PLAN_DIR}/`)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${PLAN_DIR}/\n`);
  } catch (e) {
    console.warn(`plan folder not ignored in ${cwd}: ${(e as Error).message}`);
  }
}

/* One save per turn: the watcher and a settling can both reach the ending, and
   a second report of the same plan is noise in the seat's inbox. */
const saved = new Set<string>();

/** The path an existing `plan.md` moves to before a new one is written:
 *  `plan.1.md`, or the next free `plan.<n>.md` when earlier rounds already
 *  hold that name. History, not a fixed backup slot — a scout resumed several
 *  times keeps every round it actually wrote. */
function nextPlanRotation(path: string): string {
  const dir = dirname(path);
  const stem = basename(path, ".md");
  let n = 1;
  while (existsSync(join(dir, `${stem}.${n}.md`))) n += 1;
  return join(dir, `${stem}.${n}.md`);
}

/** Save this turn's plan, if this worker was a scout and left one. An earlier
 *  plan at the same path is kept, not lost: a later turn that answers but
 *  never really replans (a short failure message with `exitCode === 0`) must
 *  not erase the good plan a round before it wrote. */
export function saveScoutPlan(a: AgentOps.NamedAgent): { path: string; text: string } | null {
  const by = startedByOf(a);
  if (!by || a.exitCode !== 0) return null;
  const root = a.seatRoot ?? projectRootOf(a.cwd) ?? a.cwd;
  if (!rolePlans(root, by.role)) return null;
  const text = answerOf(by.tui, readText(runFiles(a.name).out))?.trim();
  if (!text) return null;
  const path = join(a.cwd, PLAN_FILE);
  const key = `${a.name}:${a.startedAt}`;
  try {
    ignorePlanDir(a.cwd);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) renameSync(path, nextPlanRotation(path));
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o644 });
  } catch (e) {
    console.warn(`plan not saved for ${a.name}: ${(e as Error).message}`);
    return null;
  }
  if (a.seatRoot && !saved.has(key)) {
    saved.add(key);
    addReport({ root: a.seatRoot, agent: a.name, text: `STATE: plan saved to ${path}\n${text}` });
  }
  return { path, text };
}
