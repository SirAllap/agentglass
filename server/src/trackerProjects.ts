/*
 * Which tracker a repository's cards live in.
 *
 * One small file, `tracker-projects.json`, mapping a repository (`owner/name`)
 * to "clickup" or "jira". A repository with no entry is "auto", and auto is
 * not stored: it is the absence of a choice, so the file stays empty on a
 * machine that never needed one.
 *
 * Why a setting at all: `ORBIT-1042` in a branch name is the same string in
 * both trackers, and with both connected nothing in the text says which one
 * holds it. The prefix usually settles it (see web/src/lib/trackerApi.ts);
 * this is for the repository where it does not.
 *
 * Ceiling: the key is the repository, not a branch or a folder inside it, so a
 * monorepo whose teams use different trackers picks one for all of it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TRACKER_CHOICES, type TrackerChoice } from "../../shared/providers.ts";

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "tracker-projects.json");
let override: string | null = null;
/** Test seam, so a suite never reads or writes the developer's own choices. */
export function __setTrackerProjectsPath(p: string | null): void { override = p; }
const path = (): string => override ?? FILE;

/** `owner/name`, GitHub's own alphabet. Anything else is not a repository. */
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** A hand-edited file can hold anything; past this many entries it is not ours. */
const MAX_ENTRIES = 500;

/** Only well-formed entries survive a read; a broken file is an empty one. */
export function trackerProjects(): Record<string, Exclude<TrackerChoice, "auto">> {
  try {
    const p = path();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, Exclude<TrackerChoice, "auto">> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_ENTRIES) break;
      if (REPO.test(k) && (v === "clickup" || v === "jira")) out[k.toLowerCase()] = v;
    }
    return out;
  } catch { return {}; }
}

export function setTrackerChoice(repo: unknown, choice: unknown): { ok: true; projects: ReturnType<typeof trackerProjects> } | { ok: false; error: string } {
  if (typeof repo !== "string" || !REPO.test(repo)) return { ok: false, error: "repo must be owner/name" };
  if (typeof choice !== "string" || !(TRACKER_CHOICES as readonly string[]).includes(choice)) {
    return { ok: false, error: "tracker must be auto, clickup or jira" };
  }
  const all = trackerProjects();
  const key = repo.toLowerCase();
  if (choice === "auto") delete all[key]; else all[key] = choice as "clickup" | "jira";
  if (Object.keys(all).length > MAX_ENTRIES) return { ok: false, error: "too many repositories" };
  const p = path();
  mkdirSync(dirname(p), { recursive: true });
  // Written beside and renamed over, so a crash leaves the old file, not half of one.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  return { ok: true, projects: all };
}
