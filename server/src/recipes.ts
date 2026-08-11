/*
 * The commands you saved, as opposed to the commands we found.
 *
 * `terminal.ts` already answers "what can I run in this repo" by walking its
 * Makefiles and package.json — 322 entries on a real checkout, and every one of
 * them a single line with no arguments. That list DISCOVERS; it cannot
 * remember. So the three-step thing you worked out yesterday, with the one
 * value that changes each time, has nowhere to live and ends up as a shell
 * function outside the app.
 *
 * This is where it lives instead. Kept beside config.json in a file a person
 * can read and edit, for the same reason clickup-views.json is: it is a handful
 * of short strings, it is not a secret, and being able to open it in an editor
 * is worth more than any storage engine.
 *
 * The whole file is written with one thing in mind: a recipe is text that
 * becomes a process with the user's permissions. Everything below that looks
 * like paranoia is that.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Recipe, RecipeParam } from "../../shared/types.ts";

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "commands.json",
);

/** Test seam, so a suite never reads or writes somebody's own recipes. */
let override: string | null = null;
export function __setRecipesPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

interface Store { recipes: Recipe[] }
let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    cache = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Store) : { recipes: [] };
  } catch {
    // A malformed file is not a reason to lose the app. It is a reason to act
    // as though there are no recipes, which is visible and recoverable — the
    // file is still on disk, untouched, for somebody to fix by hand.
    cache = { recipes: [] };
  }
  cache!.recipes = Array.isArray(cache!.recipes) ? cache!.recipes : [];
  /*
   * A file that did not go through saveRecipe has not met its guards.
   *
   * A boot recipe is command execution at start — the one thing the save path
   * polices hardest, and the one thing a hand-written file can carry without
   * ever being asked. So the read path runs the same check and forgets the
   * boot flag on anything that would have been refused, rather than fire it
   * on faith. The recipe still shows in the list, only a hand-edited
   * `rm -rf` with `"boot": true` no longer runs.
   */
  cache!.recipes = cache!.recipes.map((r) =>
    r && r.boot && invalid(r) ? { ...r, boot: false } : r);
  return cache!;
}

function save(s: Store): void {
  try {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), JSON.stringify(s, null, 2) + "\n");
  } catch { /* the list still works this session; it just will not survive */ }
  cache = s;
}

export const recipes = (): Recipe[] => load().recipes;

/**
 * The ones offered in a given checkout.
 *
 * A recipe scoped to a repository shows up in that repository AND in its
 * worktrees, which is the whole point of the scope: `make migrate` belongs to a
 * project, not to one directory of it. Matched on the path prefix rather than
 * asking git, because this is called on every render of a menu.
 */
export function recipesFor(root: string): Recipe[] {
  return recipes().filter((r) => r.scope === "global" || (!!r.repo && (root === r.repo || root.startsWith(r.repo + "/") || sameFamily(root, r.repo))));
}

/** `~/code/app` and `~/code/app-PROJ-1` are the same project to a person, and
 *  git worktrees are conventionally cut as siblings named after the parent. */
function sameFamily(root: string, repo: string): boolean {
  const base = repo.split("/").pop() ?? "";
  const mine = root.split("/").pop() ?? "";
  return !!base && (mine === base || mine.startsWith(base + "-"));
}

/**
 * A value, made safe to sit inside a command line.
 *
 * Double quotes with the four characters that still mean something inside them
 * escaped. Chosen over single quotes because this has to hold in bash, zsh AND
 * fish, and fish does not read `'\''` the way the others do — a quoting trick
 * that works in three shells beats a prettier one that works in two.
 *
 * The point is not tidiness. Without this, a parameter is a place to write
 * `; rm -rf ~` and have the app run it.
 */
export function shellQuote(v: string): string {
  return `"${v.replace(/([\\"$`])/g, "\\$1")}"`;
}

/** Patterns that get a confirmation whether or not the author asked for one.
 *  Deliberately short: a list long enough to feel thorough is a list people
 *  learn to click through. */
const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\bdrop\s+(database|table)\b|--force\b|--hard\b|\bmkfs\b|>\s*\/dev\/[sh]d/i;
export const looksDestructive = (steps: string[]): boolean => DESTRUCTIVE.test(steps.join("\n"));

export interface Rendered {
  /** Ready to run, in order, with every value substituted and quoted. */
  steps: string[];
  /** True when anything here should be shown and confirmed first. */
  confirm: boolean;
  missing: string[];
}

/**
 * A recipe plus its values, as the lines that will actually run.
 *
 * Substitution happens ONCE and never re-scans its own output, which is the
 * difference between quoting a value and merely hoping: a value containing
 * `{{other}}` cannot introduce a second substitution, because there is no
 * second pass to find it.
 *
 * A `flag` is not a value, it is a presence. Its text goes in when it is on and
 * nothing goes in when it is off, so `--rebuild-fe` reads the way a flag reads
 * everywhere else rather than as `"false"`.
 */
export function renderSteps(r: Recipe, values: Record<string, string>): Rendered {
  const missing: string[] = [];
  const subs = new Map<string, string>();
  for (const p of r.params ?? []) {
    const raw = values[p.key];
    if (p.type === "flag") {
      // Its own text, unquoted — it is ours, not the user's, and quoting a flag
      // would hand `"--rebuild-fe"` to the shell as one argument.
      // A leading `!` on a flag's text means "on by default" — the author's
      // choice, stripped here so it never reaches a command line.
      const text = (p.value || `--${p.key}`).replace(/^!/, "");
      subs.set(p.key, raw === "1" || raw === "true" ? text : "");
      continue;
    }
    if (raw === undefined || raw === "") { missing.push(p.key); subs.set(p.key, ""); continue; }
    if (p.type === "choice" && p.options?.length && !p.options.includes(raw)) {
      // A closed list that accepts anything is not a closed list.
      missing.push(p.key); subs.set(p.key, ""); continue;
    }
    subs.set(p.key, shellQuote(raw));
  }
  const steps = r.steps.map((line) =>
    line.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_m, k: string) => subs.get(k) ?? ""));
  return { steps, confirm: !!r.confirm || looksDestructive(steps), missing };
}

/** What a recipe must have before it is allowed into the file. Returns the
 *  reason it was refused, or null. */
export function invalid(r: Partial<Recipe>): string | null {
  if (!r.name?.trim()) return "A recipe needs a name";
  if (!Array.isArray(r.steps) || !r.steps.some((s) => s.trim())) return "A recipe needs at least one step";
  if (r.scope === "repo" && !r.repo) return "A recipe scoped to a repository needs one";
  for (const p of r.params ?? []) {
    if (!/^[A-Za-z0-9_-]+$/.test(p.key || "")) return `"${p.key}" is not a usable parameter name`;
  }
  /*
   * A command that runs at start runs with nobody watching it start. That is
   * fine for a `docker compose up -d`, and it is not fine for anything the
   * file would otherwise make somebody confirm first: there is no Run dialog
   * at boot to hold a value, to say "always ask first", or to stand between a
   * line and `rm -rf`. Each of these is refused here, once, so a boot recipe
   * that got in can actually run — and the app never meets one it has to
   * silently skip.
   */
  if (r.boot) {
    if ((r.params ?? []).length) return "A command that runs at start cannot have parameters — nothing is there to fill them in";
    if (r.confirm) return "A command that runs at start cannot ask first — it fires with nobody to ask";
    if (looksDestructive(r.steps)) return "A command that runs at start cannot read as destructive — it fires with nobody to confirm it";
  }
  return null;
}

let seq = 0;
export function saveRecipe(r: Recipe): { ok: boolean; error?: string; recipe?: Recipe } {
  const why = invalid(r);
  if (why) return { ok: false, error: why };
  const s = load();
  const id = r.id || `r${Date.now().toString(36)}${(seq++).toString(36)}`;
  const next: Recipe = {
    ...r, id,
    name: r.name.trim(),
    steps: r.steps.map((x) => x.trimEnd()).filter((x) => x.trim()),
    addedAt: r.addedAt || Date.now(),
  };
  save({ recipes: [...s.recipes.filter((x) => x.id !== id), next] });
  return { ok: true, recipe: next };
}

export function removeRecipe(id: string): { ok: boolean } {
  const s = load();
  save({ recipes: s.recipes.filter((r) => r.id !== id) });
  return { ok: true };
}

/** For a test's own teardown. */
export function __clear(): void { cache = { recipes: [] }; }

export type { Recipe, RecipeParam };
