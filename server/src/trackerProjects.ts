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
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TRACKER_CHOICES, type TrackerChoice } from "../../shared/providers.ts";
import { clickupReadOnly } from "../../shared/clickupWrites.ts";
import { hasCredential } from "./credentials.ts";

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "tracker-projects.json");
const WRITES_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "clickup-writes.json");
let override: string | null = null;
/** Test seam, so a suite never reads or writes the developer's own choices. */
export function __setTrackerProjectsPath(p: string | null): void { override = p; seen = null; }
const path = (): string => override ?? FILE;
const writesPath = (): string => (override ? `${override}.clickup-writes.json` : WRITES_FILE);

/** `owner/name`, GitHub's own alphabet. Anything else is not a repository. */
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** A hand-edited file can hold anything; past this many entries it is not ours. */
export const MAX_ENTRIES = 500;

/**
 * The repositories to offer a choice for, the open project's own first.
 *
 * `open` is where the app is pointed — the one somebody opens Settings to
 * change — and `known` is everything else it has a project for. The old list
 * came from `known` alone, so a project the telemetry had never seen (an
 * organisation's repository worked on from a terminal) was missing while
 * personal ones were there. `stored` is for a choice made earlier, kept in the
 * list even if the sweep has since lost the checkout.
 *
 * One repository is one row: GitHub treats `Acme/Orbit` and `acme/orbit` as the
 * same, and the first spelling — which is the open project's — wins. Anything
 * that is not `owner/name` is dropped, as the store drops it.
 */
export function reposToOffer(open: readonly string[], known: readonly string[], stored: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [...open, ...known, ...stored]) {
    const key = name.toLowerCase();
    if (seen.has(key) || !REPO.test(name)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * The parsed file, kept while its path and its size and stamp are unchanged.
 *
 * `cardFor` asks once per pull request row, and a list is four hundred of them;
 * a read of the file each time is four hundred reads of the same two lines.
 * A write through `setTrackerChoice` drops this, and a hand edit shows up as a
 * new size or stamp.
 */
let seen: { at: string; value: Record<string, Exclude<TrackerChoice, "auto">> } | null = null;

/** Only well-formed entries survive a read; a broken file is an empty one. */
export function trackerProjects(): Record<string, Exclude<TrackerChoice, "auto">> {
  try {
    const p = path();
    const s = statSync(p);
    const stamp = `${p}\u0000${s.mtimeMs}:${s.size}`;
    if (seen && seen.at === stamp) return seen.value;
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const out: Record<string, Exclude<TrackerChoice, "auto">> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Object.keys(out).length >= MAX_ENTRIES) break;
        if (REPO.test(k) && (v === "clickup" || v === "jira")) out[k.toLowerCase()] = v;
      }
    }
    seen = { at: stamp, value: out };
    return out;
  } catch { return {}; }
}

/** The choice for one repository; "auto" when it was never chosen. */
export function trackerChoiceFor(repo: string | null | undefined): TrackerChoice {
  const key = (repo ?? "").toLowerCase();
  return (key ? trackerProjects()[key] : undefined) ?? "auto";
}

/**
 * The repositories whose ClickUp writes were turned back on, one switch each.
 *
 * With Jira connected ClickUp is the fallback tracker, and a fallback is
 * read-only until the person says otherwise for a repository: `{"acme/orbit":
 * true}` is the whole file, and absence — of the file, of the entry — is off.
 * Shaped like the choices beside it on purpose; a repository's tracker and its
 * permission to write to the old one are two facts and two files.
 */
export function clickupWritesByRepo(): Record<string, true> {
  try {
    const raw = JSON.parse(readFileSync(writesPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_ENTRIES) break;
      if (REPO.test(k) && v === true) out[k.toLowerCase()] = true;
    }
    return out;
  } catch { return {}; }
}

export function setClickupWrites(repo: unknown, on: unknown): { ok: true; writes: Record<string, true> } | { ok: false; error: string } {
  if (typeof repo !== "string" || !REPO.test(repo)) return { ok: false, error: "repo must be owner/name" };
  if (typeof on !== "boolean") return { ok: false, error: "clickupWrites must be true or false" };
  const all = clickupWritesByRepo();
  const key = repo.toLowerCase();
  if (on) all[key] = true; else delete all[key];
  if (Object.keys(all).length > MAX_ENTRIES) return { ok: false, error: "too many repositories" };
  const p = writesPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  return { ok: true, writes: all };
}


/**
 * Why a ClickUp write must be refused for a repository, or null when it may go.
 *
 * The panel hides the controls; this is the server saying the same thing, for
 * every write route, so a surface that draws them anyway (or a client that
 * never asked) cannot move a card the team left behind. The two answers are one
 * function in `shared/clickupWrites.ts`.
 *
 * A request that names no repository is not refused HERE: the switch is per
 * repository, and one that names none has no switch to consult (the global one
 * still applies inside every write). Ceiling: the board is such a surface.
 */
export function clickupWriteRefusal(repo: unknown): string | null {
  if (typeof repo !== "string" || !REPO.test(repo)) return null;
  return clickupReadOnly({
    jiraConnected: hasCredential("jira"),
    choice: trackerChoiceFor(repo),
    writesOn: clickupWritesByRepo()[repo.toLowerCase()] === true,
  });
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
  seen = null;
  return { ok: true, projects: all };
}
