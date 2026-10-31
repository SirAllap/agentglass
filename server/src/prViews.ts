/*
 * The pull request board's saved filter views, kept per repository.
 *
 * Plain JSON in the config directory, beside clickup-prefs.json and for the same
 * reason: a handful of short rules a person may want to read or edit, no secret,
 * and it should outlive the window and reach the phone. The shape is the shared
 * one (shared/prFilter.ts); every list is run through validateViews on the way in
 * and on the way out, so a hand-edited file that no longer validates reads as
 * "no views for that repository" rather than breaking the board.
 *
 * `saved` tells "never saved" (the window may import its old localStorage presets
 * once) from "saved and now empty" (the person deleted them all: nothing to import).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateViews, type PrView } from "../../shared/prFilter.ts";

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "pr-views.json");

/** Test seam, so a suite never reads or writes the developer's own views. */
let override: string | null = null;
export function __setViewsPath(p: string | null): void { override = p; }
const path = (): string => override ?? FILE;

/** `owner/name` as GitHub spells it. Keeps a key from being anything else. */
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** More repositories than anyone works in; keeps the file from growing without bound. */
export const MAX_REPOS = 200;

function readAll(): Record<string, PrView[]> {
  try {
    if (!existsSync(path())) return {};
    const raw = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, PrView[]> = {};
    for (const [repo, list] of Object.entries(raw)) {
      const v = validateViews(list);
      if (REPO_RE.test(repo) && typeof v !== "string") out[repo] = v;
    }
    return out;
  } catch { return {}; }
}

export function viewsFor(repo: string): { views: PrView[]; saved: boolean } {
  const all = readAll();
  return { views: all[repo] ?? [], saved: repo in all };
}

/** Validate and write one repository's whole list. Nothing is written when anything is refused. */
export function setViewsFor(repo: string, input: unknown): { ok: true; views: PrView[] } | { ok: false; error: string } {
  if (!REPO_RE.test(repo)) return { ok: false, error: "repo must be owner/name" };
  const v = validateViews(input);
  if (typeof v === "string") return { ok: false, error: v };
  const all = readAll();
  if (!(repo in all) && Object.keys(all).length >= MAX_REPOS) return { ok: false, error: `views are kept for at most ${MAX_REPOS} repositories` };
  // Order is the array's: renumbered so a hand-written gap or repeat cannot stick.
  all[repo] = v.map((x, i) => ({ ...x, order: i }));
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `could not save the views: ${(e as Error).message}` };
  }
  return { ok: true, views: all[repo]! };
}
