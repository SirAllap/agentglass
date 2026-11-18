/**
 * Evidence of life for a running tool call.
 *
 * A tool call that has been open for eight minutes is either a long build or a
 * wedged CLI, and the input side cannot tell you which: both look like a
 * PreToolUse with no Post. Every threshold built on elapsed time alone is
 * therefore a guess, and it is wrong in both directions — warn at five minutes
 * and half the warnings are healthy builds, write the pair off at thirty and a
 * genuinely long job vanishes from the fleet while it is still working.
 *
 * So ask a different question: not "how long has this been open" but "when did
 * this session last produce evidence that it is alive". Every source is local
 * and independent of the hook stream, which by definition has gone quiet.
 *
 * ## What the transcript actually does, measured
 *
 * The obvious source is the transcript file, and the obvious rule — "it stopped
 * growing, so the session is hung" — is wrong. Measured against a real Claude
 * Code run with a 43-second Bash call:
 *
 *     command starts   22:18:07
 *     transcript mtime 22:18:10     <- the tool_use record being written
 *     command ends     22:18:50
 *     transcript mtime 22:18:10     <- unchanged for the whole call
 *
 * The CLI writes the call at the start and the result at the end, and nothing
 * in between. A quiet transcript during a tool call is therefore the *normal*
 * state, and a rule built on it would flag every long build as hung — the exact
 * false positive this is meant to retire.
 *
 * That measurement turns the transcript into a different and more useful
 * signal. If it grows *well after* a call opened, the CLI has moved on: the
 * call finished and the Post event never reached us. That is a lost pair, not a
 * hang, and today it is indistinguishable from one for a full thirty minutes.
 *
 * ## What each tool class can be held to
 *
 * A single rule cannot work, because tools differ in what they are expected to
 * leave behind:
 *
 *  - Edit / Write / NotebookEdit name the file they will touch, so that file
 *    not changing is a real absence.
 *  - Bash may write anywhere or nowhere, so movement under its working
 *    directory is evidence *for* life and its absence proves nothing.
 *  - Read / Grep / Glob finish in moments and leave nothing behind, so minutes
 *    of open call with the CLI silent is a genuine stall.
 *  - WebFetch, WebSearch and MCP tools leave nothing local at all.
 *
 * Which is why `unknown` is a first-class answer here and is rendered as one.
 * Claiming a hang we cannot see is how the current thresholds lost trust, and
 * repeating that with better wording would be no improvement.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { OpenToolCall, Liveness } from "../../shared/types.ts";
import { transcriptPathOf } from "./transcripts.ts";

/** Tools whose own input names a file they are about to change. Bash is absent
 *  on purpose: its command may write anywhere, or nowhere, and guessing a path
 *  for it would manufacture evidence rather than find it. */
const WRITES_A_FILE = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Tools that finish in moments and leave nothing behind but their result. An
 *  open call here is not a long job — there is no such thing as a long Glob. */
const LEAVES_NOTHING = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);

/** Tools whose work happens somewhere we cannot watch. Named rather than
 *  inferred, so a new local tool defaults to being checked rather than excused. */
const WATCHES_NOTHING = new Set(["WebFetch", "WebSearch", "Task"]);

/**
 * How long after a call opens the transcript may still be describing *it*.
 *
 * Measured at about three seconds for the tool_use record. Twenty is generous
 * enough that a loaded machine is not called a lost pair, and short enough to
 * catch a real one within a poll or two.
 */
const SETTLE_MS = 20_000;

/**
 * How long expected evidence may be absent before that absence means something.
 *
 * This is a threshold, which is what #134 set out to retire — but it is a
 * threshold on *silence where noise was expected*, not on how long a job is
 * allowed to take. A three-minute Edit that never touched its file is stuck
 * whatever the machine's speed; a three-hour build that keeps writing is not.
 */
const QUIET_MS = 3 * 60_000;

/** Test counter: every stat this module issues. */
let statCalls = 0;
export const evidenceStatCalls = () => statCalls;

/** Directory listing per directory, valid while the directory's own mtime is
 *  unchanged: entries only appear or vanish when it moves. */
const listCache = new Map<string, { mtime: number; names: string[] }>();
/** Newest-mtime answer per directory, valid for NEWEST_TTL_MS. An edit to an
 *  existing file does not move the directory mtime, so this one expires by
 *  time (checked on read; no timer) instead of by mtime. */
const newestCache = new Map<string, { at: number; newest: number | null }>();
const NEWEST_TTL_MS = 2000;
const DIR_CACHE_MAX = 256;
export const clearEvidenceDirCache = () => { listCache.clear(); newestCache.clear(); };
const remember = <V>(m: Map<string, V>, k: string, v: V) => {
  if (m.size >= DIR_CACHE_MAX && !m.has(k)) m.delete(m.keys().next().value as string);
  m.set(k, v);
};

/** mtime in ms, or null when the path is gone, unreadable, or was never given.
 *  A tool that has not created its target yet is not evidence of anything. */
async function mtimeOf(path: string | null | undefined): Promise<number | null> {
  if (!path) return null;
  try {
    statCalls++;
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Bounded so a home directory pointed at by mistake cannot turn into a
 *  thousand stats on every poll. */
const DIR_ENTRY_MAX = 400;
/** Entries in flight at once. Every stat is off the loop anyway; the batch is
 *  what keeps a directory on a slow disk from queueing four hundred of them. */
const ENTRY_BATCH = 64;

/**
 * The freshest thing to have happened in a directory, one level down.
 *
 * For Bash this is the only signal there is. A directory's mtime moves when an
 * entry is created or removed inside it, so a build writing objects, a test run
 * dropping a cache, a `git` command touching `.git` — all of it shows up here
 * without walking a tree. Nothing is skipped: `node_modules`, `dist` and
 * `target` are exactly where a build proves it is alive, which is the opposite
 * of what those directories mean to the repo scanner.
 *
 * Asynchronous because this is where POST /ingest was spending 11,945 ms: two
 * hundred open calls times four hundred entries, every stat blocking the loop
 * that the terminal and every other route ride. Awaiting them hands that loop
 * back between batches; the answer is the same mtime it always was.
 */
async function newestUnder(dir: string | null | undefined, now: number): Promise<number | null> {
  if (!dir) return null;
  const fresh = newestCache.get(dir);
  if (fresh && now >= fresh.at && now - fresh.at < NEWEST_TTL_MS) return fresh.newest;
  let newest: number | null = null;
  try {
    statCalls++;
    const own = (await stat(dir)).mtimeMs;
    newest = own;
    let names: string[];
    const listed = listCache.get(dir);
    if (listed && listed.mtime === own) names = listed.names;
    else {
      names = await readdir(dir);
      remember(listCache, dir, { mtime: own, names });
    }
    for (let i = 0; i < names.length && i < DIR_ENTRY_MAX; i += ENTRY_BATCH) {
      const at = await Promise.all(names.slice(i, i + ENTRY_BATCH).map((n) => mtimeOf(join(dir, n))));
      for (const t of at) if (t !== null && (newest === null || t > newest)) newest = t;
    }
    remember(newestCache, dir, { at: now, newest });
  } catch { /* unreadable or gone — no evidence, which is not a verdict */ }
  return newest;
}

/** Whether a name is an MCP tool, which by definition runs somewhere else. */
const isMcp = (tool: string) => tool.startsWith("mcp__");

/** Which sources this tool can be held to. Exported so the collector below and
 *  the classifier cannot drift apart about what a Bash call is. */
export const watchesDirectory = (tool: string): boolean =>
  !WRITES_A_FILE.has(tool) && !LEAVES_NOTHING.has(tool) && !WATCHES_NOTHING.has(tool) && !isMcp(tool);

export interface EvidenceSources {
  transcriptAt: number | null;
  targetAt: number | null;
  dirAt: number | null;
}

/**
 * Turn the evidence into a verdict, for one call.
 *
 * Exported for the tests, which is the point: this decides what the fleet says
 * about a session, and it should be arguable against fixtures rather than only
 * against whatever a live machine happens to be doing.
 */
export function classify(
  call: Pick<OpenToolCall, "tool_name" | "since">,
  src: EvidenceSources,
  now: number,
): Liveness {
  const { tool_name, since } = call;
  const open = now - since;

  // The CLI moved on. The transcript only grows when a call is recorded or a
  // result arrives, so growth this long after the call opened means the result
  // landed and our Post event never did. A bookkeeping failure, and
  // specifically not a hang — today the two are indistinguishable for half an
  // hour, and both are reported as a running tool.
  if (open > SETTLE_MS && src.transcriptAt !== null && src.transcriptAt > since + SETTLE_MS) return "lost";

  if (isMcp(tool_name) || WATCHES_NOTHING.has(tool_name)) return "unknown";

  if (WRITES_A_FILE.has(tool_name)) {
    // The file it named is the whole point of the call.
    if (src.targetAt !== null && src.targetAt >= since) return "working";
    // No readable target at all — an input we could not parse, or a file the
    // tool has not created yet — is not the same as a target that failed to
    // move. Only the second is a claim we are entitled to make.
    if (src.targetAt === null) return open > QUIET_MS ? "unknown" : "working";
    return open > QUIET_MS ? "stuck" : "working";
  }

  if (LEAVES_NOTHING.has(tool_name)) {
    // There is no such thing as a slow Glob. Minutes of open call with nothing
    // written anywhere is the one case where silence really is the answer.
    return open > QUIET_MS ? "stuck" : "working";
  }

  // Bash, and anything else local we have not named. Movement under the working
  // directory is evidence for life; its absence is not evidence against it,
  // because plenty of legitimate commands compute for minutes writing nothing.
  // Saying "I cannot tell" is the honest answer, and it is what the UI shows.
  if (src.dirAt !== null && src.dirAt >= since) return "working";
  return open > QUIET_MS ? "unknown" : "working";
}

/**
 * Attach the freshest evidence found for each open call, and the verdict it
 * supports.
 *
 * Kept out of db.ts because it reaches the filesystem and the transcript index,
 * and a query module that quietly stats files is a query module nobody can
 * reason about. Work is deduplicated per session and per directory, and the
 * call list is capped at 200 upstream.
 */
export async function withEvidence(calls: OpenToolCall[], now = Date.now()): Promise<OpenToolCall[]> {
  // One transcript stat per session, and one scan per directory: a session with
  // four tools open would otherwise pay for the same answer four times over.
  const perSession = new Map<string, number | null>();
  const perDir = new Map<string, number | null>();
  const out: OpenToolCall[] = [];

  for (const c of calls) {
    if (!perSession.has(c.session_id)) {
      perSession.set(c.session_id, await mtimeOf(transcriptPathOf(c.session_id)));
    }
    const transcriptAt = perSession.get(c.session_id) ?? null;
    const targetAt = WRITES_A_FILE.has(c.tool_name) ? await mtimeOf(c.target) : null;

    // The directory is only scanned for the tools it can say anything about.
    // Reading a project directory to decide whether a WebFetch is alive would
    // be work spent to learn nothing.
    let dirAt: number | null = null;
    if (watchesDirectory(c.tool_name) && c.dir) {
      if (!perDir.has(c.dir)) perDir.set(c.dir, await newestUnder(c.dir, now));
      dirAt = perDir.get(c.dir) ?? null;
    }

    // Freshest wins, and which one it was is reported: "the transcript grew",
    // "the file it promised to touch changed" and "something moved in the
    // working directory" are different claims, and a reader deciding whether to
    // trust the verdict wants to know which was made.
    const candidates: Array<[number, NonNullable<OpenToolCall["evidenceKind"]>]> = [];
    if (transcriptAt !== null) candidates.push([transcriptAt, "transcript"]);
    if (targetAt !== null) candidates.push([targetAt, "target"]);
    if (dirAt !== null) candidates.push([dirAt, "dir"]);
    candidates.sort((a, b) => b[0] - a[0]);
    const best = candidates[0];

    out.push({
      ...c,
      ...(best ? { evidenceAt: best[0] } : {}),
      // Nothing to read. Not the same as "nothing happened": a tool with no
      // expected artifact and a session whose transcript we cannot find both
      // land here, and calling either of them stuck would be the old mistake in
      // a new place.
      evidenceKind: best ? best[1] : "none",
      liveness: classify(c, { transcriptAt, targetAt, dirAt }, now),
    });
  }
  return out;
}
