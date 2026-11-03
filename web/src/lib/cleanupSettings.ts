/*
 * "After a PR is merged": the choices the Settings section draws, and the
 * decisions behind them, pulled out of the component so they can be tested
 * (there is no renderer in this project).
 *
 * The values are the server's `cleanup.*` settings (server/src/serverSettings.ts).
 * Four modes, one choice. "Offer at merge time" is drawn only when the PR view
 * has a merge action to hang it on (`MERGE_ACTION_IN_PR_VIEW`); the PR view
 * does have one, so it is. The tick box in the merge confirmation itself is
 * not here: it lands with the PR view's own change, and until then the mode
 * behaves as Ask, which its sentence says.
 */

export type CleanupMode = "off" | "ask" | "atMerge" | "auto";
export type CleanupKind = "docker" | "worktree" | "branch" | "stashes" | "evidence" | "notes" | "tab" | "agent-scratch" | "agent-history";

/** The PR view draws a merge button and a merge confirmation (MergeBox, MergeDialog). If it ever loses them, flip this and the mode is not drawn. */
export const MERGE_ACTION_IN_PR_VIEW = true;

export interface ModeCard { id: CleanupMode; title: string; icon: "x" | "bell" | "merge" | "sparkles"; text: string; now: string; isDefault?: true }

const ALL_MODES: readonly ModeCard[] = [
  { id: "off", title: "Off", icon: "x", text: "Never offer a cleanup. Leftovers stay until you remove them yourself.", now: "Off: leftovers stay until you remove them yourself." },
  { id: "ask", title: "Ask", icon: "bell", text: "Offers to clean up the local leftovers of every merged PR. Nothing is removed until you confirm.", now: "Ask: every merged PR is offered a cleanup.", isDefault: true },
  { id: "atMerge", title: "Offer at merge time", icon: "merge", text: "Offers the cleanup as soon as you merge a PR, and still offers it on any PR merged elsewhere.", now: "Offer at merge time: the cleanup is offered right after you merge, and on any other merged PR." },
  { id: "auto", title: "Automatic", icon: "sparkles", text: "Cleans up on its own once a PR is merged. A PR with a safety block is left alone.", now: "Automatic: runs in the background, one merged PR at a time, in the order they were merged. If you close agentglass it picks up where it stopped the next time it opens, and that first read also catches PRs merged in the last day. It removes the worktree, branch, evidence folders and Docker leftovers; briefs are moved to archive/. Blocked PRs (uncommitted changes, a live session, a stacked PR, commits not in the PR) are left alone and the reason shows on the PR." },
];

/** The modes the section offers. A mode that cannot work here is left out, never drawn dead. */
export const cleanupModes = (mergeAction: boolean = MERGE_ACTION_IN_PR_VIEW): readonly ModeCard[] =>
  ALL_MODES.filter((m) => m.id !== "atMerge" || mergeAction);

export const isCleanupMode = (v: unknown): v is CleanupMode => ALL_MODES.some((m) => m.id === v);

/** What the server holds, or the default when it says something this build does not know. */
export const modeOf = (v: unknown, mergeAction: boolean = MERGE_ACTION_IN_PR_VIEW): CleanupMode =>
  isCleanupMode(v) && cleanupModes(mergeAction).some((m) => m.id === v) ? v : "ask";

export const nowLine = (mode: CleanupMode): string => (ALL_MODES.find((m) => m.id === mode) ?? ALL_MODES[1]!).now;

export interface KindRow { id: CleanupKind; name: string; text: string; icon: "package" | "folder" | "branch" | "archive" | "image" | "file" | "term" }

export const CLEANUP_KIND_ROWS: readonly KindRow[] = [
  { id: "docker", name: "Docker", icon: "package", text: "The image and containers built for the PR branch." },
  { id: "worktree", name: "Worktree", icon: "folder", text: "The extra checkout folder made for the PR branch." },
  { id: "branch", name: "Branch", icon: "branch", text: "The local branch. The branch on GitHub stays." },
  { id: "stashes", name: "Stashes", icon: "archive", text: "Saved as a patch file first, then dropped." },
  { id: "evidence", name: "Evidence", icon: "image", text: "Screenshots and recordings kept for this PR." },
  { id: "notes", name: "Notes", icon: "file", text: "The notes file you or an agent kept for this PR." },
  { id: "tab", name: "Tab", icon: "term", text: "The agent tab that worked on it, once nothing runs in it." },
  { id: "agent-scratch", name: "Agent scratch", icon: "folder", text: "The agent's cache and scratch for that checkout. It makes them again." },
  { id: "agent-history", name: "Session history", icon: "archive", text: "Kept so you can resume or read what the agent did." },
];

const KINDS = CLEANUP_KIND_ROWS.map((k) => k.id);
/** What a project that never touched the ticks holds (the server's DEFAULT_CLEANUP_INCLUDE): everything but the session history. */
export const DEFAULT_INCLUDE: readonly CleanupKind[] = KINDS.filter((k) => k !== "agent-history");

/** The stored list as the ticks: what the server sent, in the server's order, unknown words dropped. */
export const includeOf = (v: unknown): CleanupKind[] =>
  Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : [...DEFAULT_INCLUDE];

/** One tick flipped, kept in the canonical order so two saves of the same choice are the same bytes. */
export const withKind = (list: readonly CleanupKind[], kind: CleanupKind, on: boolean): CleanupKind[] =>
  KINDS.filter((k) => (k === kind ? on : list.includes(k)));

/* ---- evidence folders: cleanup.evidenceRoots, per project ---- */

/** The stored list as drawn: strings only, the server's own cleaning is not repeated. */
export const rootsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** The line under an empty list: why nothing is found. */
export const NO_EVIDENCE_ROOT = "No folder is set, so no evidence is found. Add the folder your screenshots are kept in; a folder inside it whose name starts with the card id is the PR's.";

/** One folder the person typed, or the sentence that says why not (the server checks again: absolute or ~/, no .., not a bare top folder). */
export function addRoot(list: readonly string[], raw: string): { ok: true; list: string[] } | { ok: false; why: string } {
  const p = raw.trim().replace(/\/+$/, "");
  if (!p) return { ok: false, why: "Type a folder first." };
  if (!(p.startsWith("/") || p.startsWith("~/")) || p.split("/").includes("..")) return { ok: false, why: "Use a full path (/... or ~/...) without \"..\"." };
  if (p.split("/").filter(Boolean).length < 2) return { ok: false, why: "That folder is too broad: use the one that holds the evidence folders." };
  return list.includes(p) ? { ok: false, why: "That folder is already listed." } : { ok: true, list: [...list, p] };
}
export const dropRoot = (list: readonly string[], p: string): string[] => list.filter((x) => x !== p);

/* ---- briefs folder: cleanup.config.briefsDir, per project ---- */

/** The stored `cleanup.config` body as drawn: its briefs folder, empty = off. */
export const briefsOf = (v: unknown): string => (v && typeof v === "object" && typeof (v as { briefsDir?: unknown }).briefsDir === "string" ? (v as { briefsDir: string }).briefsDir : "");

/** The label under the field: what a brief is here, and that it is never an evidence folder. */
export const BRIEFS_HELP = "Briefs whose name has the card id are moved into an archive/ folder inside this one, never deleted. Not an evidence folder: screenshots typed here are moved, not removed. Empty = off.";

/** The folder the person typed (empty turns it off), or the sentence that says why not; the server checks again. */
export function checkBriefsDir(raw: string): { ok: true; dir: string } | { ok: false; why: string } {
  const p = raw.trim().replace(/\/+$/, "");
  if (!p) return { ok: true, dir: "" };
  if (!(p.startsWith("/") || p.startsWith("~/")) || p.split("/").includes("..")) return { ok: false, why: "Use a full path (/... or ~/...) without \"..\"." };
  if (p.split("/").filter(Boolean).length < 2) return { ok: false, why: "That folder is too broad: use the one that holds the briefs." };
  return { ok: true, dir: p };
}

/** The whole stored body with a new briefs folder: the door replaces the object, so every other field is carried over. */
export const withBriefsDir = (body: unknown, dir: string): Record<string, unknown> => ({ ...(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}), briefsDir: dir });

/* ---- other folders: cleanup.otherFolders, per project ---- */

export const NO_OTHER_FOLDERS = "No pattern is set. Add one for leftovers that do not start with the card id, e.g. a baseline checkout named by its number.";
export const OTHER_FOLDERS_HELP = "Leftovers of a card whose name does not start with its id. {card} is the card id (ORBIT-1042), {number} its digits (1042, never inside a longer number); * matches inside one name. A git worktree is removed like the card's own, a plain folder with its size shown. Refused: the main checkout, home and any other repository.";

const BRACES = /\{(card|number)\}/;
/** One pattern the person typed, or the sentence that says why not (the server checks again). */
export function addPattern(list: readonly string[], raw: string): { ok: true; list: string[] } | { ok: false; why: string } {
  const p = raw.trim().replace(/\/+$/, "");
  if (!p) return { ok: false, why: "Type a pattern first." };
  if (!(p.startsWith("/") || p.startsWith("~/")) || p.split("/").includes("..")) return { ok: false, why: "Use a full path (/... or ~/...) without \"..\"." };
  const cut = p.lastIndexOf("/"), parent = p.slice(0, cut), leaf = p.slice(cut + 1);
  if (/[*?[\]{}]/.test(parent)) return { ok: false, why: "The folder before the last name must be written out, with no wildcards or {card}/{number}." };
  if (parent.split("/").filter(Boolean).length < 2) return { ok: false, why: "That parent folder is too broad: put the pattern inside a project folder." };
  if (!BRACES.test(leaf)) return { ok: false, why: "The last name needs {card} or {number}, or it would match for every card." };
  if (/[{}]/.test(leaf.replace(/\{(card|number)\}/g, ""))) return { ok: false, why: "Only {card} and {number} may be written in braces." };
  return list.includes(p) ? { ok: false, why: "That pattern is already listed." } : { ok: true, list: [...list, p] };
}

/** The days field: whole days, 1 to 365; anything else is not a value yet. */
export function daysOf(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 1 && n <= 365 ? n : null;
}

/** The switch is on when a number of days is stored (0 is the server's "never"). The field keeps showing the last value so turning the switch on again is one click. */
export const DEFAULT_DAYS = 14;
export const daysState = (stored: unknown): { on: boolean; shown: string } => {
  const n = typeof stored === "number" && Number.isFinite(stored) ? Math.round(stored) : 0;
  return n > 0 ? { on: true, shown: String(n) } : { on: false, shown: String(DEFAULT_DAYS) };
};

/** What a write comes back as: applied now, waiting for the person's click (a looser value from an agent), or refused. */
export function saveLine(r: { ok: boolean; applied?: boolean; error?: string } | null): { phase: "saved" | "waits" | "error"; text: string } {
  if (!r) return { phase: "error", text: "The server did not answer." };
  if (!r.ok) return { phase: "error", text: r.error ?? "The server refused the change." };
  return r.applied === false ? { phase: "waits", text: "Waiting for your approval." } : { phase: "saved", text: "Saved" };
}

/** The project names in the project list: the folder name, with the full path as the title. */
export const projectName = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;

/**
 * "owner/repo" of a project, read from its remotes the way the PR view names a repository
 * (server/src/prs.ts `repoIdFor`: `upstream`, then `origin`), for the GitHub forms
 * `https://github.com/o/r(.git)` and `git@github.com:o/r(.git)`; null for anything else,
 * and the table then shows the folder name. Not a general remote parser: other hosts are not here.
 */
export function repoSlug(remotes: readonly { name: string; fetchUrl: string }[]): string | null {
  for (const name of ["upstream", "origin"]) {
    const url = remotes.find((r) => r.name === name)?.fetchUrl.trim() ?? "";
    const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
    if (m) return m[1]!;
  }
  return null;
}


/*
 * The project list (two or more projects): one row each; the page beside it
 * saves the clicked project the moment a control is touched. Nothing here is a "set all" in the server: a bulk Apply
 * is one door write per setting and per project's `root`, the same writes an
 * agent makes with `agentglass-ui settings set cleanup.* --root <p>`.
 */

/** What one project holds now, as the three settings read. */
export interface ProjectValues { mode: CleanupMode; days: number; include: CleanupKind[] }

export const valuesOf = (mode: unknown, days: unknown, include: unknown): ProjectValues =>
  ({ mode: modeOf(mode), days: daysState(days).on ? Number(daysState(days).shown) : 0, include: includeOf(include) });

/** One project alone is the page with no list; the project list (rows, ticks, bulk bar) starts at two. */
export const showList = (projects: number): boolean => projects >= 2;

/** The short mode name on a project's row. */
export const MODE_BADGE: Record<CleanupMode, string> = { off: "Off", ask: "Ask", atMerge: "Offer at merge", auto: "Auto" };

/** The tiny "custom" dot: the days or the kinds differ from what a new project starts with. */
export const isCustom = (v: ProjectValues): boolean => v.days > 0 || v.include.length !== DEFAULT_INCLUDE.length || DEFAULT_INCLUDE.some((k) => !v.include.includes(k));

/** The project the person last clicked, per viewer; a project that is gone falls back to the first. */
const PICK_KEY = "agentglass.cleanupProject";
export function readPick(pool: readonly string[], store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string {
  try { const v = store?.getItem(PICK_KEY); if (v && pool.includes(v)) return v; } catch { /* private mode */ }
  return pool[0] ?? "";
}
export function writePick(root: string, store: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try { store?.setItem(PICK_KEY, root); } catch { /* private mode */ }
}

/** One row flipped; the ticked keep the order they were ticked in, the table draws them in the list's. */
export const toggleRoot = (ticked: readonly string[], root: string): string[] =>
  ticked.includes(root) ? ticked.filter((r) => r !== root) : [...ticked, root];

export type TickState = "none" | "some" | "all";
/** The header checkbox over the rows shown: unticked, indeterminate, or ticked. */
export const tickState = (ticked: readonly string[], shown: readonly string[]): TickState => {
  const n = shown.filter((r) => ticked.includes(r)).length;
  return n === 0 ? "none" : n === shown.length ? "all" : "some";
};

/** The header checkbox: all shown rows on, or (when they already were) off; rows hidden by the search keep their tick. */
export const toggleShown = (ticked: readonly string[], shown: readonly string[]): string[] =>
  tickState(ticked, shown) === "all" ? ticked.filter((r) => !shown.includes(r)) : [...ticked, ...shown.filter((r) => !ticked.includes(r))];

/** Ticks of projects that are gone are dropped. */
export const stillThere = (ticked: readonly string[], pool: readonly string[]): string[] => ticked.filter((r) => pool.includes(r));

/** Nine projects or more get a search box; with fewer it would only be in the way. */
export const SEARCH_FROM = 9;
export const showSearch = (total: number): boolean => total >= SEARCH_FROM;

export const filterProjects = (pool: readonly string[], q: string, nameOf: (r: string) => string): string[] => {
  const needle = q.trim().toLowerCase();
  return needle ? pool.filter((p) => nameOf(p).toLowerCase().includes(needle)) : [...pool];
};

/** One project's write: the three settings, in the order the section lists them. */
export interface RootWrite { root: string; writes: { id: string; value: unknown }[] }
export const writePlan = (roots: readonly string[], v: ProjectValues): RootWrite[] =>
  roots.map((root) => ({
    root,
    writes: [{ id: "cleanup.mode", value: v.mode }, { id: "cleanup.autoCleanDays", value: v.days }, { id: "cleanup.include", value: v.include }],
  }));

export interface RootResult { root: string; ok: boolean; reason?: string }
export type Writer = (root: string, id: string, value: unknown) => Promise<{ ok: boolean; applied?: boolean; error?: string } | null>;

/** Projects run side by side; a project's own settings run in order and stop at its first refusal. One failing never stops the others. */
export async function runPlan(plan: readonly RootWrite[], write: Writer): Promise<RootResult[]> {
  return Promise.all(plan.map(async ({ root, writes }): Promise<RootResult> => {
    for (const w of writes) {
      const line = saveLine(await write(root, w.id, w.value).catch(() => null));
      if (line.phase === "error") return { root, ok: false, reason: line.text };
    }
    return { root, ok: true };
  }));
}

/** Retry touches only the projects that failed. */
export const retryPlan = (plan: readonly RootWrite[], results: readonly RootResult[]): RootWrite[] =>
  plan.filter((p) => results.some((r) => r.root === p.root && !r.ok));

/** The bulk bar after Apply: "5 saved", or "4 of 5 saved" with how many failed (each failed row says why). */
export function bulkLine(results: readonly RootResult[]): { saved: number; failed: number; text: string } {
  const failed = results.filter((r) => !r.ok).length, saved = results.length - failed;
  return { saved, failed, text: failed ? `${saved} of ${results.length} saved` : `${saved} saved` };
}
