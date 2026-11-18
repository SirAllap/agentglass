import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEvidence, evidenceStatCalls, clearEvidenceDirCache } from "../src/evidence.ts";

const call = (dir: string, i: number) =>
  ({ session_id: "s" + i, tool_name: "Bash", since: 1, dir, target: null, id: i }) as never;

const T0 = 1_000_000;

test("10 events inside 2 s = one scan", async () => {
  clearEvidenceDirCache();
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}`), "x");
  const before = evidenceStatCalls();
  for (let i = 0; i < 10; i++) await withEvidence([call(dir, 1)], T0 + i * 100);
  const used = evidenceStatCalls() - before;
  // 1 dir + 50 entries once; ten scans would be 510.
  expect(used).toBe(51);
  console.log("stats for 10 events in 2 s:", used);
});

test("an edit to an existing file is seen after 2 s, and the listing is not re-read", async () => {
  clearEvidenceDirCache();
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  const f = join(dir, "a");
  writeFileSync(f, "x");
  const old = new Date(Date.now() - 60_000);
  utimesSync(f, old, old);
  utimesSync(dir, old, old);
  const first = (await withEvidence([call(dir, 1)], T0))[0] as { evidenceAt?: number };
  const edited = new Date();
  utimesSync(f, edited, edited); // existing file edit: dir mtime does not move
  utimesSync(dir, old, old);
  const within = (await withEvidence([call(dir, 1)], T0 + 1500))[0] as { evidenceAt?: number };
  expect(within.evidenceAt).toBe(first.evidenceAt);
  const after = (await withEvidence([call(dir, 1)], T0 + 2100))[0] as { evidenceAt?: number };
  expect(after.evidenceAt).toBeGreaterThan(first.evidenceAt ?? 0);
});

test("a changed directory mtime re-reads the listing", async () => {
  clearEvidenceDirCache();
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  writeFileSync(join(dir, "a"), "x");
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old); // not left to clock granularity
  await withEvidence([call(dir, 1)], T0);
  writeFileSync(join(dir, "b"), "x"); // new entry: dir mtime moves to now
  const t = new Date(Date.now() + 5000);
  utimesSync(join(dir, "b"), t, t);
  const r = (await withEvidence([call(dir, 1)], T0 + 2100))[0] as { evidenceAt?: number };
  expect(r.evidenceAt).toBe(Math.floor(t.getTime()) as number);
});
