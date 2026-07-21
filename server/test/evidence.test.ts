import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenToolCall } from "../../shared/types.ts";

/**
 * Evidence of life, against real files with real mtimes.
 *
 * The whole point of the signal is that it reads something the hook stream
 * cannot fake, so mocking the filesystem here would test the opposite of what
 * matters.
 */
let dir: string, transcript: string, target: string, ev: typeof import("../src/evidence.ts");

/**
 * The session the fixture transcript belongs to, registered in the same table
 * the scanner writes, since that is what the lookup reads.
 *
 * Minted per run rather than fixed. db.ts binds its file at import and the
 * first suite to import it decides that file for the whole process, so in a
 * full `bun test` this one can land on the developer's real database — where
 * every previous run of this test has left a row pointing at a temp directory
 * that no longer exists. The lookup takes the newest row for the session, hands
 * back a deleted path, and the evidence this file is about reads as "none".
 * A fresh id cannot collide with its own history.
 */
const SESSION = `sess-alive-${crypto.randomUUID().slice(0, 8)}`;

const call = (over: Partial<OpenToolCall> = {}): OpenToolCall => ({
  session_id: SESSION,
  source_app: "claude-code",
  tool_name: "Bash",
  since: Date.now() - 60_000,
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-evidence-"));
  process.env.AGENTGLASS_ROOT = dir;
  // A database of its own, and a config directory of its own. Without them this
  // suite reads whatever the machine already has: on a fresh CI checkout that is
  // nothing and every assertion holds, while on any developer's machine the real
  // database answers first and the same three tests fail. A test that only passes
  // where there is no history is not testing what it claims to.
  process.env.AGENTGLASS_DB = join(dir, "evidence.db");
  process.env.XDG_CONFIG_HOME = dir;
  transcript = join(dir, "session.jsonl");
  target = join(dir, "target.ts");
  writeFileSync(transcript, "{}\n");
  writeFileSync(target, "export const x = 1;\n");

  const { db } = await import("../src/db.ts");
  await import("../src/transcripts.ts"); // creates transcript_files
  db.query(
    `INSERT INTO transcript_files (path, session_id, source_app, project_path, lines_done, size, mtime)
     VALUES (?, ?, 'claude-code', ?, 1, 2, 0)`
  ).run(transcript, SESSION, dir);

  ev = await import("../src/evidence.ts");
});

afterAll(async () => {
  // Take the fixture row out again. On a machine where the temp database above
  // did not win, this row lands in the real one, and a test that leaves debris
  // in the database it borrowed is a test that breaks the next run.
  try {
    const { db } = await import("../src/db.ts");
    db.query("DELETE FROM transcript_files WHERE session_id = ?").run(SESSION);
  } catch { /* nothing to clean */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** Backdate a file, so "fresh" and "stale" are facts rather than timing luck. */
const age = (path: string, secondsAgo: number) => {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(path, t, t);
};

describe("evidence of life", () => {
  it("reports the transcript growing, which is evidence the hooks cannot give", () => {
    age(transcript, 3);
    const [r] = ev.withEvidence([call()]);
    expect(r!.evidenceKind).toBe("transcript");
    expect(Date.now() - r!.evidenceAt!).toBeLessThan(10_000);
  });

  it("reports the file a write tool named, when that is the fresher signal", () => {
    // The shape that matters: a long Edit whose transcript went quiet, but
    // whose target is being written right now.
    age(transcript, 600);
    age(target, 2);
    const [r] = ev.withEvidence([call({ tool_name: "Edit", target })]);
    expect(r!.evidenceKind).toBe("target");
    expect(Date.now() - r!.evidenceAt!).toBeLessThan(10_000);
  });

  it("prefers the freshest of the two rather than a fixed order", () => {
    age(transcript, 2);
    age(target, 600);
    const [r] = ev.withEvidence([call({ tool_name: "Edit", target })]);
    expect(r!.evidenceKind).toBe("transcript");
  });

  it("ignores a target for tools that write nowhere in particular", () => {
    // Bash may write anywhere or nowhere. Reading a path off it would be
    // manufacturing evidence, which is worse than having none.
    age(transcript, 900);
    age(target, 1);
    const [r] = ev.withEvidence([call({ tool_name: "Bash", target })]);
    expect(r!.evidenceKind).toBe("transcript");
    expect(Date.now() - r!.evidenceAt!).toBeGreaterThan(800_000 / 1000);
  });

  it("says `none` rather than guessing when nothing is readable", () => {
    // An unknown session and a target that does not exist: the honest answer is
    // that we cannot tell, and it must not read as "stuck".
    const [r] = ev.withEvidence([
      call({ session_id: "sess-unknown", tool_name: "Edit", target: join(dir, "never-created.ts") }),
    ]);
    expect(r!.evidenceKind).toBe("none");
    expect(r!.evidenceAt).toBeUndefined();
  });

  it("stats a session's transcript once however many of its calls are open", () => {
    // Four open tools on one session is one question about that session.
    const calls = [call(), call({ tool_name: "Grep" }), call({ tool_name: "Read" }), call({ tool_name: "Glob" })];
    const out = ev.withEvidence(calls);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((r) => r.evidenceAt)).size).toBe(1);
  });

  it("leaves every field it was given alone", () => {
    // It enriches; it must not become a place where open-call data is rewritten.
    const c = call({ tool_name: "Edit", target, since: 123 });
    const [r] = ev.withEvidence([c]);
    expect(r!.session_id).toBe(c.session_id);
    expect(r!.tool_name).toBe("Edit");
    expect(r!.since).toBe(123);
    expect(r!.target).toBe(target);
  });
});
