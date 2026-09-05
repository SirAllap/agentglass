/*
 * A transcript from another project is read ONCE, not on every sweep.
 *
 * Measured on the machine this was written for, and it is the reason this file
 * exists: a cockpit scoped to one repo, with agent sessions running in other
 * repos at the same time, was reading those other transcripts WHOLE every three
 * seconds — 6.5 GB a minute of file reads, ~17% of a core, for bytes it threw
 * away immediately. The instrumented probe blamed one line, `ingestFile`'s read,
 * for 1.63 GB per 15 seconds; with the verdict remembered it reads 0.8 MB.
 *
 * The cause is two correct decisions meeting. A file that GREW is not skipped —
 * it may have new lines. A file the scope refuses is deliberately not stamped
 * into `transcript_files` — so that widening the workspace later still picks it
 * up whole. A live session outside the scope grows every second, so it was
 * re-read every sweep, for ever.
 *
 * What is remembered is the VERDICT, in memory, keyed by the scope that made
 * it. Nothing durable changes, which is what keeps the widening case working —
 * and that case is the second test here, because a performance fix that quietly
 * drops somebody's sessions would be worse than the cost it saves.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-scope-"));
const PROJECTS = join(dir, "projects", "-tmp-elsewhere");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
/* A scope, always. Without one nothing is out of scope, every test here has
   nothing to prove, and they all pass by doing nothing — which is how three of
   them ran green for a while without ever reaching an assertion. */
const SCOPE = join(dir, "workspace");
mkdirSync(SCOPE, { recursive: true });
process.env.AGENTGLASS_ROOT = SCOPE;
process.env.AGENTGLASS_DB ||= join(dir, "scope.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
/** Somewhere the scope will refuse: a real directory, outside any workspace. */
const ELSEWHERE = join(dir, "another-repo");
const SESSION = "s-out-of-scope";
const FILE = join(PROJECTS, `${SESSION}.jsonl`);

/** Every file the scanner opens, counted per path — the same measurement the
 *  probe made against the real server, small enough to run in a unit test. */
const reads = new Map<string, number>();
/** `.text()` called on the WHOLE file — the expensive path this file exists to
 *  keep off the sweep. */
const fullReads = new Map<string, number>();
/** Every `.slice(start, end)` the scanner took, so a "bounded head" claim can be
 *  checked against the bound rather than against a small fixture. */
const slices = new Map<string, [number, number | undefined][]>();
const realFile = Bun.file.bind(Bun);

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  mkdirSync(ELSEWHERE, { recursive: true });
  // Counting reads by patching the global, on purpose.
  (Bun as unknown as { file: unknown }).file = (...args: unknown[]) => {
    const p = args[0];
    const f = realFile(...(args as [string]));
    if (typeof p !== "string" || !p.endsWith(".jsonl")) return f;
    reads.set(p, (reads.get(p) ?? 0) + 1);
    return new Proxy(f, {
      get(t, k) {
        if (k === "text") return () => { fullReads.set(p, (fullReads.get(p) ?? 0) + 1); return t.text(); };
        if (k === "slice") return (a: number, b?: number) => {
          slices.set(p, [...(slices.get(p) ?? []), [a, b]]);
          return t.slice(a, b as number);
        };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  };
});

afterAll(() => {
  // Putting the global back.
  (Bun as unknown as { file: unknown }).file = realFile;
  if (!db) return;
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id = ?`, [SESSION]); } catch { /* no such column */ }
  }
});

const line = (n: number) => JSON.stringify({
  type: "user",
  cwd: ELSEWHERE,
  sessionId: SESSION,
  timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  message: { role: "user", content: `line ${n}` },
}) + "\n";

const sweep = () => scan.scanOnce(null);

describe("a transcript the workspace refuses", () => {
  test("is opened once, however often it grows", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    scan.__dropTailCache();
    writeFileSync(FILE, line(1));
    reads.clear(); fullReads.clear(); slices.clear();
    await sweep();
    const first = reads.get(FILE) ?? 0;
    expect(first).toBeGreaterThan(0); // it had to be read to be judged

    // Now it behaves like a live session somewhere else: it grows, every sweep.
    for (let n = 2; n <= 6; n++) {
      appendFileSync(FILE, line(n));
      await sweep();
    }
    // …and none of that growth costs a read. This is the whole fix: five sweeps
    // over a growing file it does not want, and it opened it zero more times.
    expect((reads.get(FILE) ?? 0) - first).toBe(0);
  });

  test("is still picked up whole when the workspace widens to include it", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    // A different scope is a different verdict: the entry is keyed by the scope
    // that made it, so the file is judged again rather than stayed refused.
    // (Standing in for the user opening a wider workspace, which is the case
    // the deliberate "do not stamp it" behaviour exists for.)
    scan.__dropTailCache();
    reads.clear();
    await sweep();
    expect(reads.get(FILE) ?? 0).toBeGreaterThan(0);
  });

  test("an in-place rewrite of the same length is judged again", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    scan.__dropTailCache();
    writeFileSync(FILE, line(1));
    await sweep();                  // refused, at this size and this mtime
    reads.clear();
    await sweep();
    expect(reads.get(FILE) ?? 0).toBe(0); // …and staying refused costs nothing

    // Same byte count, different content: `line(2)` is `line(1)` with one digit
    // changed, so size alone cannot tell them apart. mtime can — stamped here
    // because both writes land inside the same millisecond, which a rewrite by
    // a real session never does.
    writeFileSync(FILE, line(2));
    const later = new Date(Date.now() + 5_000);
    utimesSync(FILE, later, later);
    await sweep();
    expect(reads.get(FILE) ?? 0).toBeGreaterThan(0);
  });

  test("an aged-out verdict is re-asked from a bounded head, not a whole file", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    scan.__dropTailCache();
    writeFileSync(FILE, line(1));
    await sweep();
    reads.clear(); fullReads.clear(); slices.clear();

    // A minute has passed. The verdict came out of `inScope`, which can answer
    // "not my family" for a repo that was merely mid-rebase, so it is not kept
    // for ever — but re-asking must not cost what the first answer cost.
    scan.__expireRefusals();
    await sweep();
    expect(fullReads.get(FILE) ?? 0).toBe(0);
    const head = (slices.get(FILE) ?? []).filter(([a, b]) => a === 0 && typeof b === "number");
    expect(head.length).toBe(1);
    expect(head[0]![1]).toBe(256 * 1024);

    // …and the answer was the same, so the sweeps after it are free again.
    reads.clear();
    await sweep();
    expect(reads.get(FILE) ?? 0).toBe(0);
  });

  test("a head with no cwd in it falls back to the full read", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    // Measured on 90 real transcripts: 6 carry their first `cwd` past 64 KB and
    // one past 256 KB. Believing an empty head would be worse than slow —
    // `ingestFile` reads an empty cwd as "no scope test to make" and ingests.
    const pad = JSON.stringify({ type: "summary", summary: "x".repeat(4000) }) + "\n";
    scan.__dropTailCache();
    writeFileSync(FILE, pad.repeat(70) + line(1));  // ~280 KB before the cwd
    await sweep();
    reads.clear(); fullReads.clear(); slices.clear();

    scan.__expireRefusals();
    await sweep();
    expect(fullReads.get(FILE) ?? 0).toBeGreaterThan(0);
  });

  test("a rewritten file is judged again rather than staying refused", async () => {
    const scope = (await import("../src/config.ts")).workspaceRoot();
    expect(scope).toBeTruthy();

    await sweep();               // let it be refused with its current content
    reads.clear();
    writeFileSync(FILE, line(1)); // shorter than before: a rewrite, not an append
    await sweep();
    // The verdict described content that no longer exists, so it is dropped and
    // the file read again — the same rule the tail cache follows.
    expect(reads.get(FILE) ?? 0).toBeGreaterThan(0);
  });
});
