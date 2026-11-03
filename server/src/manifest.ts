/*
 * WHAT GOT MERGED, WHAT IS RUNNING, AND WHAT WAITS FOR A VERDICT.
 *
 * The read half of the Manifest view. Everything here comes from this machine:
 * the trunk's own first-parent history, the running build's commit, the agents
 * the board already knows, and the verdicts stored beside them. Nothing is read
 * from a hand-kept file.
 *
 * Two rules live in `deriveRows` and nowhere else — which rows are signable and
 * which wait for a build — so the write guard and the view cannot disagree.
 */
import { basename } from "node:path";
import { db } from "./db.ts";
import { gitAsync } from "./git.ts";
import { defaultBranch } from "./gitwork.ts";
import { projectRootOf } from "./git.ts";
import { saidRows } from "./agentboard.ts";
import { recentPaneAgents } from "./panewt.ts";
import { buildInfo } from "./selfupdate.ts";
import { workspaceRoots } from "./config.ts";
import type {
  ManifestGroup, ManifestInProgress, ManifestProject, ManifestRow, ManifestSigned,
  ManifestSignOff, ManifestSummaryProject, ManifestCounters,
} from "../../shared/manifest.ts";
import { MANIFEST_NOTE_MAX } from "../../shared/manifest.ts";

export { MANIFEST_NOTE_MAX };

/** The window the counters and To test read. */
export const WINDOW_MS = 7 * 24 * 60 * 60_000;
/** How long a row with a verdict stays in To test, so Undo is reachable. */
export const SIGNED_TO_TEST_MS = 24 * 60 * 60_000;

export interface Commit {
  sha: string;
  /** Committer time, epoch seconds. */
  time: number;
  parents: string[];
  subject: string;
}

export interface Verdict {
  verdict: ManifestSigned;
  at: number;
  kind: "person" | "phone";
  note: string | null;
}

/** The commit a project's count begins after, and when the line was set. */
export interface StartLine {
  sha: string;
  at: number;
}

/** Where the route gets its build commit and its clock, so a test can move
 *  either without moving the machine. */
export const manifestDeps = {
  buildCommit: (): string => process.env.AGENTGLASS_MANIFEST_BUILD || buildInfo().commit,
  now: (): number => Number(process.env.AGENTGLASS_MANIFEST_NOW) || Date.now(),
};

/*
 * A ticket id, and the prefixes that look like one.
 *
 * `UTF-8`, `SHA-256` and `ISO-8601` are encodings and standards, not tickets;
 * they share the shape and would otherwise be linked to a card that does not
 * exist.
 */
const TICKET = /\b([A-Z][A-Z0-9]{1,9})-([0-9]{2,6})\b/g;
const NOT_A_TICKET = new Set(["UTF", "SHA", "ISO", "RFC", "AES", "TLS", "HTTP", "MD", "BASE"]);

export function ticketOf(subject: string): string | null {
  for (const m of subject.matchAll(TICKET)) {
    if (!NOT_A_TICKET.has(m[1]!)) return `${m[1]}-${m[2]}`;
  }
  return null;
}

/**
 * The rows, grouped once.
 *
 * `ancestors` is the set of commits the running build contains, or `null` when
 * this project has no install boundary. With no boundary nothing is called
 * outside the build: every window row is To test and signable.
 *
 * An unsigned row stays in To test for the whole window; a row with a verdict
 * stays for 24 hours after the verdict, and is Done after that. Done therefore
 * never contains a row outside the build.
 */
export function deriveRows(o: {
  commits: Commit[];
  now: number;
  verdicts: Map<string, Verdict>;
  ancestors: Set<string> | null;
  start?: StartLine | null;
}): ManifestRow[] {
  const start = o.now - WINDOW_MS;
  const signedFor = o.now - SIGNED_TO_TEST_MS;
  /* The line's own commit is in the list when the project was read recently;
     when it is older than the window (or was rewritten away) committer time is
     the only comparable thing left. */
  const lineAt = o.start ? o.commits.findIndex((c) => c.sha === o.start!.sha) : -1;
  const afterLine = (c: Commit, i: number): boolean => {
    if (!o.start) return true;
    return lineAt >= 0 ? i < lineAt : c.time * 1000 > o.start.at;
  };
  const rows: ManifestRow[] = [];
  for (const [i, c] of o.commits.entries()) {
    const v = o.verdicts.get(c.sha);
    // A verdict already given stays on screen even when it sits behind the
    // line: the person's own act is not history to hide.
    if (!v && (c.time * 1000 < start || !afterLine(c, i))) continue;
    const inBuild = o.ancestors ? o.ancestors.has(c.sha) : null;
    let group: ManifestGroup;
    if (o.ancestors && !inBuild) group = "ready";
    else if (v && v.at < signedFor) group = "done";
    else group = "toTest";
    rows.push({
      sha: c.sha,
      subject: c.subject,
      time: c.time,
      ticket: ticketOf(c.subject),
      inBuild,
      verdict: v?.verdict ?? null,
      at: v?.at ?? null,
      kind: v?.kind ?? null,
      note: v?.note ?? null,
      group,
    });
  }
  // Stable on committer time alone: a busy second keeps git's own newest-first
  // order, which is the order the pass rule compares against `git log`.
  rows.sort((a, b) => b.time - a.time);
  return rows;
}

const verdictsFor = db.query<{ sha: string; verdict: string; kind: string; at: number; note: string }, [string]>(
  "SELECT sha, verdict, kind, at, note FROM signoff WHERE project = ?",
);

export function verdicts(project: string): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  try {
    for (const r of verdictsFor.all(project)) {
      if (r.verdict !== "tested" && r.verdict !== "failed") continue;
      out.set(r.sha, {
        verdict: r.verdict,
        at: r.at,
        kind: r.kind === "phone" ? "phone" : "person",
        note: r.note || null,
      });
    }
  } catch { /* a database that cannot answer has no verdicts to add */ }
  return out;
}

const upsertVerdict = db.query<never, [string, string, string, string, string, number, string]>(
  `INSERT INTO signoff (project, sha, verdict, kind, by, at, note)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(project, sha) DO UPDATE SET
     verdict = excluded.verdict, kind = excluded.kind, by = excluded.by, note = excluded.note`,
);
const deleteVerdict = db.query<never, [string, string]>("DELETE FROM signoff WHERE project = ? AND sha = ?");

/** Signing again keeps `at`: a row does not restart its 24 hours. */
export function signOff(project: string, sha: string, verdict: ManifestSigned, kind: "person" | "phone",
  by: string, note: string | null, now = Date.now()): void {
  upsertVerdict.run(project, sha, verdict, kind, by, now, note ?? "");
}

export function clearVerdict(project: string, sha: string): void {
  deleteVerdict.run(project, sha);
}

/* ── the start line ─────────────────────────────────────────────────────── */

const startFor = db.query<{ sha: string; at: number }, [string]>(
  "SELECT sha, at FROM manifest_start WHERE project = ?",
);
const putStart = db.query<never, [string, string, number]>(
  `INSERT INTO manifest_start (project, sha, at) VALUES (?, ?, ?)
   ON CONFLICT(project) DO UPDATE SET sha = excluded.sha, at = excluded.at`,
);

export function startLine(project: string): StartLine | null {
  try {
    const r = startFor.get(project);
    return r ? { sha: r.sha, at: r.at } : null;
  } catch { /* a database that cannot answer has no line */ return null; }
}

export function setStartLine(project: string, sha: string, at: number): void {
  try { putStart.run(project, sha, at); } catch { /* a read that cannot write keeps counting from the window */ }
}

/** The first read stores the trunk's current commit; every later read keeps it. */
export function ensureStartLine(project: string, head: string, now: number): StartLine {
  const current = startLine(project);
  if (current) return current;
  setStartLine(project, head, now);
  return { sha: head, at: now };
}

/**
 * The trunk's first-parent history, and the subjects of the commits it merged.
 *
 * A merge commit shows the subject of its second parent, because "Merge pull
 * request #41 from acme/orbit" says nothing about what landed. One extra
 * `git log --no-walk` covers every such row.
 */
export async function readTrunk(root: string, now: number): Promise<{ branch: string | null; commits: Commit[]; head: string | null }> {
  const branch = await defaultBranch(root);
  if (!branch) return { branch: null, commits: [], head: null };
  const h = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  const head = h.code === 0 && /^[0-9a-f]{40}$/.test(h.stdout.trim()) ? h.stdout.trim() : null;
  const since = `--since=@${Math.floor((now - WINDOW_MS) / 1000)}`;
  const r = await gitAsync(root, ["log", "--first-parent", "--format=%H%x00%ct%x00%P%x00%s", since, branch]);
  if (r.code !== 0) return { branch, commits: [], head };
  const commits = parseCommits(r.stdout);
  const merged = commits.filter((c) => c.parents.length >= 2).map((c) => c.parents[1]!);
  if (merged.length) {
    const s = await gitAsync(root, ["log", "--no-walk", "--format=%H%x00%s", ...new Set(merged)]);
    if (s.code === 0) {
      const bySha = new Map<string, string>();
      for (const line of s.stdout.split("\n")) {
        if (!line) continue;
        const [sha = "", ...sub] = line.split("\x00");
        const subject = sub.join("\x00");
        if (sha && subject) bySha.set(sha, subject);
      }
      for (const c of commits) {
        if (c.parents.length < 2) continue;
        const subject = bySha.get(c.parents[1]!);
        if (subject) c.subject = subject;
      }
    }
  }
  return { branch, commits, head };
}

function parseCommits(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [sha = "", ct = "0", parents = "", ...rest] = line.split("\x00");
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    commits.push({ sha, time: Number(ct) || 0, parents: parents.split(" ").filter(Boolean), subject: rest.join("\x00") });
  }
  return commits;
}

/** The commits a verdict names, including ones older than the window. */
export async function commitsBySha(root: string, shas: string[]): Promise<Commit[]> {
  if (!shas.length) return [];
  const r = await gitAsync(root, ["log", "--no-walk", "--format=%H%x00%ct%x00%P%x00%s", ...shas]);
  return r.code === 0 ? parseCommits(r.stdout) : [];
}

/** The commits the running build contains, or null when it cannot be named in
 *  this checkout — either because the project is not this app's own or because
 *  the build names a commit this checkout does not have. */
export async function ancestorsOf(root: string, build: string): Promise<Set<string> | null> {
  const commit = build.trim();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
  const has = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (has.code !== 0) return null;
  const r = await gitAsync(root, ["rev-list", commit]);
  if (r.code !== 0) return null;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

/**
 * The agents working on this project.
 *
 * `saidRows` is `board()` without its hourly sweep: a GET must not write. A row
 * of another project, or one whose path is not a checkout, is not drawn.
 */
export async function inProgress(root: string, said = saidRows()): Promise<ManifestInProgress[]> {
  const here = projectRootOf(root) ?? root;
  const panes = recentPaneAgents({ cap: 200 });
  const paneOf = new Map(panes.map((p) => [p.sessionId, p.paneId]));
  const out: ManifestInProgress[] = [];
  for (const row of said) {
    const at = (row.worktree ?? "").trim();
    if (!at || (projectRootOf(at) ?? at) !== here) continue;
    out.push({
      name: row.name,
      doing: row.doing ?? "",
      branch: row.branch ?? "",
      startedAt: row.saidAt ?? 0,
      ...(row.session && paneOf.has(row.session) ? { paneId: paneOf.get(row.session)! } : null),
    });
  }
  return out;
}

function countersFor(rows: ManifestRow[], running: number): ManifestCounters {
  const ready = rows.filter((r) => r.group === "ready").length;
  return {
    merged: rows.length,
    running,
    builtWaiting: rows.some((r) => r.inBuild !== null) ? ready : null,
  };
}

/** One project's answer, with the caller's sign-off rule already decided. */
export async function readProject(root: string, signOff: ManifestSignOff, now: number): Promise<ManifestProject> {
  const { branch, commits: trunk, head } = await readTrunk(root, now);
  const ancestors = branch ? await ancestorsOf(root, manifestDeps.buildCommit()) : null;
  const known = verdicts(root);
  // A verdict older than the window still names a row the person signed, so
  // its commit is read even though `git log --since` left it out.
  const missing = [...known.keys()].filter((sha) => !trunk.some((c) => c.sha === sha));
  const commits = missing.length ? [...trunk, ...(await commitsBySha(root, missing))] : trunk;
  const start = branch && head ? ensureStartLine(root, head, now) : null;
  const rows = branch ? deriveRows({ commits, now, verdicts: known, ancestors, start }) : [];
  const windowUnsigned = commits.filter((c) => c.time * 1000 >= now - WINDOW_MS && !known.has(c.sha)).length;
  const listedUnsigned = rows.filter((r) => !r.verdict).length;
  // The line's own commit is not "older"; it is the point counting begins at.
  const lineCommit = start ? commits.find((c) => c.sha === start.sha) : undefined;
  const atLine = lineCommit && lineCommit.time * 1000 >= now - WINDOW_MS && !known.has(lineCommit.sha) ? 1 : 0;
  const running = branch ? await inProgress(root) : [];
  return {
    root,
    name: basename(root) || root,
    boundary: ancestors ? "build" : "none",
    trunk: !!branch,
    signOff,
    start: start ? { ...start, omitted: Math.max(0, windowUnsigned - listedUnsigned - atLine) } : null,
    rows,
    inProgress: running,
    counters: countersFor(rows, running.length),
    left: rows.filter((r) => r.group === "toTest" && !r.verdict).length,
  };
}

/* ── the summary the rail dot reads ─────────────────────────────────────── */

const SUMMARY_TTL_MS = 60_000;
let summaryCache: { at: number; rows: ManifestSummaryProject[] } | null = null;

/** Called after any write, so the dot cannot stay on for a row already signed. */
export function clearManifestSummary(): void {
  summaryCache = null;
}

/**
 * `GET /manifest` with no project.
 *
 * Cached for a minute because the rail asks for it every minute whether the view
 * is open or not, and each project costs a git log. `maySign` is applied on the
 * way out rather than baked into the cache: two callers of one server can differ.
 */
export async function summarize(now: number, maySign: boolean): Promise<ManifestSummaryProject[]> {
  let rows = summaryCache && now - summaryCache.at < SUMMARY_TTL_MS ? summaryCache.rows : null;
  if (!rows) {
    rows = [];
    for (const root of workspaceRoots()) {
      const { branch, commits, head } = await readTrunk(root, now);
      const ancestors = branch ? await ancestorsOf(root, manifestDeps.buildCommit()) : null;
      const known = verdicts(root);
      const start = branch && head ? ensureStartLine(root, head, now) : null;
      const derived = branch ? deriveRows({ commits, now, verdicts: known, ancestors, start }) : [];
      rows.push({
        root,
        name: basename(root) || root,
        left: derived.filter((r) => r.group === "toTest" && !r.verdict).length,
        signOff: "yes",
        trunk: !!branch,
      });
    }
    summaryCache = { at: now, rows };
  }
  return rows.map((p) => ({ ...p, left: maySign && p.trunk ? p.left : 0 }));
}
