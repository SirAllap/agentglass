/*
 * transcript_files had no delete at all, and Claude Code removes old
 * transcripts by itself, so rows for files that are gone grew for ever
 * (measured: 5320 of 8697 rows). pruneGoneTranscripts drops those, but never a
 * file that is still there, never a recent row, and never the last row of a
 * source_app (the project picker is seeded from this table at boot). A file must
 * be missing on two passes in a row, and retention 0 (keep forever) drops
 * nothing: scanner events have no dedupe key, so a file that comes back after
 * its row is gone is re-read from line 0 and counted twice.
 */
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gone-"));
process.env.AGENTGLASS_DB = join(dir, "gone.db");
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let tx: typeof import("../src/transcripts.ts");
beforeAll(async () => {
  db = await import("../src/db.ts");
  tx = await import("../src/transcripts.ts");
});

const OLD = 1_000;
const put = (path: string, app: string, mtime: number, project = `/p/${app}`) =>
  db.db.run(
    "INSERT INTO transcript_files (path, session_id, source_app, project_path, mtime) VALUES (?, ?, ?, ?, ?)",
    [path, path, app, project, mtime],
  );
const paths = () => db.db.query<{ path: string }, []>("SELECT path FROM transcript_files ORDER BY path").all().map((r) => r.path);

test("drops old rows for deleted files, keeps live files, recent rows and the last row of a project", () => {
  // One process runs every file: db.ts may already be open on another file's
  // database, with rows of its own, so start from an empty table.
  db.db.run("DELETE FROM transcript_files");
  const live = join(dir, "live.jsonl");
  writeFileSync(live, "{}\n");
  const goneA = join(dir, "gone-a.jsonl");
  const goneB = join(dir, "gone-b.jsonl");
  const goneRecent = join(dir, "gone-recent.jsonl");
  const goneOnly = join(dir, "gone-only.jsonl");
  put(live, "acme", OLD);
  put(goneA, "acme", OLD);
  put(goneB, "acme", OLD);
  put(goneRecent, "acme", Date.now());
  put(goneOnly, "orbit", OLD);

  expect(tx.pruneGoneTranscripts(1)).toBe(0); // first miss only marks them
  expect(tx.pruneGoneTranscripts(1)).toBe(2);
  expect(paths()).toEqual([goneOnly, goneRecent, live].sort());
});

test("works in bounded slices and wraps around to finish the table", () => {
  db.db.run("DELETE FROM transcript_files");
  const keep = join(dir, "keep.jsonl");
  writeFileSync(keep, "{}\n");
  put(keep, "acme", OLD);
  for (let i = 0; i < 5; i++) put(join(dir, `g${i}.jsonl`), "acme", OLD);

  let total = 0;
  for (let i = 0; i < 8; i++) total += tx.pruneGoneTranscripts(1, 2);
  expect(total).toBe(5);
  expect(paths()).toEqual([keep]);
});

test("keep forever (retention 0) drops nothing", () => {
  db.db.run("DELETE FROM transcript_files");
  const a = join(dir, "forever-a.jsonl");
  const b = join(dir, "forever-b.jsonl");
  put(a, "acme", OLD);
  put(b, "acme", OLD);
  for (let i = 0; i < 3; i++) expect(tx.pruneGoneTranscripts(0)).toBe(0);
  expect(paths()).toEqual([a, b].sort());
});

test("a file back on disk between two passes keeps its row", () => {
  db.db.run("DELETE FROM transcript_files");
  const keep = join(dir, "away-keep.jsonl");
  writeFileSync(keep, "{}\n");
  const away = join(dir, "away.jsonl");
  put(keep, "acme", OLD);
  put(away, "acme", OLD);
  expect(tx.pruneGoneTranscripts(1)).toBe(0); // away is missing once
  writeFileSync(away, "{}\n"); // the folder comes back
  expect(tx.pruneGoneTranscripts(1)).toBe(0);
  rmSync(away);
  expect(tx.pruneGoneTranscripts(1)).toBe(0); // a fresh first miss, not a second
  expect(tx.pruneGoneTranscripts(1)).toBe(1);
  expect(paths()).toEqual([keep]);
});

test("the last row with a project_path is kept, however many blank ones share its app", () => {
  db.db.run("DELETE FROM transcript_files");
  const named = join(dir, "picker-named.jsonl");
  const blank1 = join(dir, "picker-z-blank1.jsonl");
  const blank2 = join(dir, "picker-z-blank2.jsonl");
  put(named, "orbit", OLD);
  put(blank1, "orbit", OLD, "");
  put(blank2, "orbit", OLD, "");
  tx.pruneGoneTranscripts(1);
  tx.pruneGoneTranscripts(1);
  expect(paths()).toContain(named);
});

test("a mark for a row that left the window does not outlive a lap", () => {
  db.db.run("DELETE FROM transcript_files");
  const keep = join(dir, "lap-keep.jsonl");
  writeFileSync(keep, "{}\n");
  const g = join(dir, "lap-gone.jsonl");
  put(keep, "acme", OLD);
  put(g, "acme", OLD);
  expect(tx.pruneGoneTranscripts(1)).toBe(0); // g marked, lap wraps
  db.db.run("UPDATE transcript_files SET mtime = ? WHERE path = ?", [Date.now(), g]); // g leaves the window
  expect(tx.pruneGoneTranscripts(1)).toBe(0); // lap without g: its mark is dropped
  db.db.run("UPDATE transcript_files SET mtime = ? WHERE path = ?", [OLD, g]); // back in the window
  expect(tx.pruneGoneTranscripts(1)).toBe(0); // first miss again, not a second
  expect(paths()).toContain(g);
});
