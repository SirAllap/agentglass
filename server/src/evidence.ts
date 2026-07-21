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
 * this session last produce evidence that it is alive". Two sources, both local
 * and both independent of the hook stream that has gone quiet:
 *
 *  - the transcript file, which the CLI appends to as a turn streams. Growth
 *    there is the strongest signal available and costs one stat.
 *  - the file a write tool named in its own input. If Edit said it would touch
 *    src/foo.ts, then src/foo.ts changing is that tool doing its job.
 *
 * This module only *reports* freshness; nothing here classifies a session. That
 * is deliberate: the numbers want watching against real runs — including a real
 * hang — before any state machine is moved onto them.
 */
import { statSync } from "node:fs";
import type { OpenToolCall } from "../../shared/types.ts";
import { transcriptPathOf } from "./transcripts.ts";

/** Tools whose own input names a file they are about to change. Bash is absent
 *  on purpose: its command may write anywhere, or nowhere, and guessing a path
 *  for it would manufacture evidence rather than find it. */
const WRITES_A_FILE = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** mtime in ms, or null when the path is gone, unreadable, or was never given.
 *  A tool that has not created its target yet is not evidence of anything. */
function mtimeOf(path: string | null | undefined): number | null {
  if (!path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Attach the freshest evidence found for each open call.
 *
 * Kept out of db.ts because it reaches the filesystem and the transcript index,
 * and a query module that quietly stats files is a query module nobody can
 * reason about. Two stats per open call, and the list is capped at 200.
 */
export function withEvidence(calls: OpenToolCall[]): OpenToolCall[] {
  // One transcript stat per session, not per call: a session with four tools
  // open would otherwise stat the same file four times for one answer.
  const perSession = new Map<string, number | null>();

  return calls.map((c) => {
    if (!perSession.has(c.session_id)) {
      perSession.set(c.session_id, mtimeOf(transcriptPathOf(c.session_id)));
    }
    const transcriptAt = perSession.get(c.session_id) ?? null;
    const targetAt = WRITES_A_FILE.has(c.tool_name) ? mtimeOf(c.target) : null;

    // Freshest wins, and which one it was is reported: "the transcript grew"
    // and "the file it promised to touch changed" are different claims, and a
    // reader deciding whether to trust the number wants to know which was made.
    let evidenceAt: number | undefined;
    let evidenceKind: OpenToolCall["evidenceKind"];
    if (transcriptAt !== null && (targetAt === null || transcriptAt >= targetAt)) {
      evidenceAt = transcriptAt;
      evidenceKind = "transcript";
    } else if (targetAt !== null) {
      evidenceAt = targetAt;
      evidenceKind = "target";
    } else {
      // Nothing to read. Not the same as "nothing happened": a tool with no
      // expected artifact and a session whose transcript we cannot find both
      // land here, and calling either of them stuck would be the old mistake
      // in a new place.
      evidenceKind = "none";
    }

    return { ...c, ...(evidenceAt === undefined ? {} : { evidenceAt }), evidenceKind };
  });
}
