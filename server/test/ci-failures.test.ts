/*
 * The failing part of a failed CI check, cut out of its log.
 *
 * The log shapes are the ones a real run of this kind of repository prints
 * (bun, pytest, django, a linter, a smoke script), with the bytes that made
 * them hard: ESC colour codes, an ISO timestamp on every line, a byte-order mark
 * on the first, bun's `##[error]` copy of a message it already printed, and a
 * name-only summary at the end. All names and values are invented.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-ci-failures-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { extractFailures, redact, signature, annotationFailures, outputFailures, readCheckFailures, storedFailures, MAX_EXCERPT, MAX_FAILURES } = await import("../src/ciFailures.ts");
const { db } = await import("../src/db.ts");
type Src = import("../src/ciFailures.ts").FailureSources;

const ESC = "\x1b";
const T = "2026-10-01T10:00:00.1234567Z ";
const stamp = (s: string) => "\uFEFF" + s.split("\n").map((l) => T + l).join("\n");

// Shape of a bun run where two tests fail: the error block comes BEFORE its (fail) line,
// ##[error] repeats the message, and the summary lists the names again with no detail.
const BUN = stamp(`##[group]Run cd server && bun test
(pass) orbit board > renders its lanes [1.20ms]
 98 |   const lanes = board.lanes();
 99 |   expect(lanes.length).toBe(4);
                              ^
${ESC}[31merror${ESC}[0m: expect(received).toBe(expected)

Expected: 4
Received: 5

      at <anonymous> (/home/runner/work/orbit/orbit/server/test/board.test.ts:99:30)

##[error]Expected: 4
Received: 5

      at <anonymous> (/home/runner/work/orbit/orbit/server/test/board.test.ts:99:30)
(fail) orbit board > keeps four lanes [3.10ms]
(pass) orbit board > sorts cards [0.20ms]
error: timeout after 20000ms
(fail) orbit sync > gives its slot back [20000.15ms]
(skip) orbit sync > not on CI

2 tests failed:
(fail) orbit board > keeps four lanes [3.10ms]
(fail) orbit sync > gives its slot back [20000.15ms]

 1 pass
 2 fail
Ran 3 tests across 1 files. [1.00s]
##[error]Process completed with exit code 2.`);

describe("bun", () => {
  const r = extractFailures(BUN);
  test("one failure per failing test; the summary does not double them", () => {
    expect(r.framework).toBe("bun");
    expect(r.failures.map((f) => f.title)).toEqual(["orbit board > keeps four lanes", "orbit sync > gives its slot back"]);
    expect(r.more).toBe(0);
  });
  test("the block belongs to ITS test, not the passing one before it", () => {
    expect(r.failures[0]!.excerpt).toContain("Expected: 4");
    expect(r.failures[0]!.excerpt).not.toContain("renders its lanes");
    expect(r.failures[1]!.excerpt).toBe("error: timeout after 20000ms");
  });
  test("the ##[error] copy is dropped, and so are the escape bytes, the stamps and the BOM", () => {
    const x = r.failures[0]!.excerpt;
    expect(x).not.toContain("##[error]");
    expect(x).not.toContain(ESC);
    expect(x).not.toMatch(/2026-10-01T/);
    expect(x).not.toContain("﻿");
  });
  test("a test that fails twice is one failure", () => {
    const twice = extractFailures(`error: a\n(fail) t [1ms]\nerror: a\n(fail) t [1ms]`);
    expect(twice.failures).toHaveLength(1);
  });
});

const PYTEST = stamp(`=================================== FAILURES ===================================
_____________________ TestBoard.test_lane_count _____________________
[gw2] linux -- Python 3.12.3

self = <test_board.TestBoard object at 0x7f82ecce2e00>

    def test_lane_count(self):
>       assert len(board.lanes()) == 4
E       assert 5 == 4
E        +  where 5 = len([1, 2, 3, 4, 5])

tests/test_board.py:12: AssertionError
_____________________ TestSync.test_retry _____________________
>       raise TimeoutError("took 3.2s")
E       TimeoutError: took 3.2s
=========================== short test summary info ============================
FAILED tests/test_board.py::TestBoard::test_lane_count - assert 5 == 4
FAILED tests/test_sync.py::TestSync::test_retry - TimeoutError: took 3.2s
========================= 2 failed, 40 passed in 12.30s =========================`);

describe("pytest", () => {
  const r = extractFailures(PYTEST);
  test("one block per ____ title ____; the short summary is not a failure", () => {
    expect(r.framework).toBe("pytest");
    expect(r.failures.map((f) => f.title)).toEqual(["TestBoard.test_lane_count", "TestSync.test_retry"]);
    expect(r.failures[0]!.excerpt).toContain("E       assert 5 == 4");
    expect(r.failures[0]!.excerpt).not.toContain("short test summary");
  });
  test("the signature is the E line, with numbers and times normalised", () => {
    expect(r.failures[1]!.signature).toBe("TestSync.test_retry :: TimeoutError: took <t>");
  });
});

const DJANGO = stamp(`Found 12 test(s).
======================================================================
FAIL: test_ordering (orbit.tests.test_cards.CardTests.test_ordering)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/app/orbit/tests/test_cards.py", line 40, in test_ordering
    self.assertEqual(cards, [1, 2])
AssertionError: Lists differ: [2, 1] != [1, 2]

----------------------------------------------------------------------
Ran 12 tests in 1.2s

FAILED (failures=1)
##[error]Process completed with exit code 1.`);

describe("django", () => {
  test("a FAIL block runs to the closing rule, not into 'Ran N tests'", () => {
    const r = extractFailures(DJANGO);
    expect(r.framework).toBe("django");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.title).toBe("test_ordering (orbit.tests.test_cards.CardTests.test_ordering)");
    expect(r.failures[0]!.excerpt).toEndWith("AssertionError: Lists differ: [2, 1] != [1, 2]");
  });
  test("a build's `ERROR: chunk too large` is not a unittest failure", () => {
    const r = extractFailures(stamp(`ERROR: chunk too large\nsomething\n##[error]Process completed with exit code 1.`));
    expect(r.framework).toBe("step");
  });
});

describe("jest and tsc-shaped lint", () => {
  test("a ● block per test; Console is not a failure; the summary ends the block", () => {
    const r = extractFailures(stamp(`FAIL src/board.test.ts\n  ● board › keeps four lanes\n\n    expect(received).toBe(expected)\n\n    Expected: 4\n    Received: 5\n\n  ● Console\n\n    console.log hello\n\nTests:       1 failed, 3 passed, 4 total`));
    expect(r.failures.map((f) => f.title)).toEqual(["board › keeps four lanes"]);
    expect(r.failures[0]!.excerpt).toContain("Received: 5");
    expect(r.failures[0]!.excerpt).not.toContain("Tests:");
  });
  test("one failure per error line, in both output shapes", () => {
    const r = extractFailures(stamp(`web/src/board.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nserver/src/sync.ts:30:7 - error TS2304: Cannot find name 'lane'.`));
    expect(r.framework).toBe("tsc");
    expect(r.failures.map((f) => f.title)).toEqual(["web/src/board.ts", "server/src/sync.ts"]);
  });
});

describe("a failing step with nothing to parse", () => {
  const SMOKE = stamp(`##[group]Run make smoke\nmake smoke\nshell: /usr/bin/bash -e {0}\n##[endgroup]\nserver on http://localhost:4123\nWeb UI → http://localhost:4123/\nRetention → 8 days\n##[error]Process completed with exit code 7.\nPost job cleanup.\nTerminate orphan process: pid (1)`);
  test("falls back to the last lines of THAT step, not the cleanup after it", () => {
    const r = extractFailures(SMOKE);
    expect(r.framework).toBe("step");
    expect(r.failures[0]!.title).toBe("make smoke");
    expect(r.failures[0]!.excerpt).toContain("Retention → 8 days");
    expect(r.failures[0]!.excerpt).toEndWith("Process completed with exit code 7.");
    expect(r.failures[0]!.excerpt).not.toContain("shell:");
    expect(r.failures[0]!.excerpt).not.toContain("cleanup");
  });
  test("the step name the jobs API gave is the title", () => {
    expect(extractFailures(SMOKE, { step: "Smoke (production bundle)" }).failures[0]!.title).toBe("Smoke (production bundle)");
  });
  test("a green log yields nothing, not an invented failure", () => {
    expect(extractFailures(stamp("(pass) a [1ms]\n 1 pass\n 0 fail")).failures).toEqual([]);
  });
});

describe("limits", () => {
  test("an excerpt over the cap keeps both ends and says it was cut", () => {
    const r = extractFailures(`(pass) a [1ms]\nerror: first\n${"x".repeat(10_000)}\nlast line\n(fail) big [1ms]`);
    const f = r.failures[0]!;
    expect(f.truncated).toBe(true);
    expect(f.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT + 20);
    expect(f.excerpt.startsWith("error: first")).toBe(true);
    expect(f.excerpt.endsWith("last line")).toBe(true);
  });
  test("more than the cap of failures keeps the first ones and counts the rest", () => {
    const log = Array.from({ length: 14 }, (_, i) => `error: boom ${i}\n(fail) t${i} [1ms]`).join("\n");
    const r = extractFailures(log);
    expect(r.failures).toHaveLength(MAX_FAILURES);
    expect(r.more).toBe(4);
  });
  test("detail in the middle of a 1.2 MB log is found: the whole log is read, not a 400 KB tail", () => {
    // The real shape: a long quiet start, the failure near 290 KB, a long run of passes, then names only.
    const quiet = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${T}(pass) ${tag} case ${i} [0.1ms]`).join("\n");
    const log = [quiet(4_800, "early"), `${T}error: expect(received).toBe(expected)`, `${T}Expected: 3`, `${T}(fail) orbit lands on the pad [2.1ms]`, quiet(15_000, "late"), `${T}1 tests failed:`, `${T}(fail) orbit lands on the pad [2.1ms]`].join("\n");
    expect(log.length).toBeGreaterThan(1_000_000);
    expect(log.slice(-400_000)).not.toContain("Expected: 3");
    const r = extractFailures(log);
    expect(r.failures.map((f) => f.title)).toEqual(["orbit lands on the pad"]);
    expect(r.failures[0]!.excerpt).toContain("Expected: 3");
  });
});

describe("redaction runs before anything is kept", () => {
  test.each([
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used", "ghp_"],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnop1234567890", "abcdefghijklmnop"],
    ["a key assignment", "API_KEY=supersecretvalue123", "supersecretvalue123"],
    ["a url with credentials", "git clone https://bot:hunter2pass@example.com/x.git", "hunter2pass"],
    ["an email", "author jane.doe@example.com failed", "jane.doe@"],
    ["an AWS key id", "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ])("%s", (_n, input, leaked) => expect(redact(input)).not.toContain(leaked));

  test("it reaches the excerpt, the title and the signature", () => {
    const r = extractFailures(`error: bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n(fail) uses jane@example.com [1ms]`);
    const all = JSON.stringify(r);
    expect(all).not.toContain("ghp_abc");
    expect(all).not.toContain("jane@");
    // the signature once leaked a token the excerpt had hidden
    expect(r.failures[0]!.signature).not.toContain("ghp_");
  });
  test("a log with a secret in a step's output comes out redacted", () => {
    const r = extractFailures(stamp(`##[group]Run ./deploy.sh\n##[endgroup]\nusing PASSWORD=hunter2hunter2 and key sk-abcdefghijklmnopqrstuvwxyz\n##[error]Process completed with exit code 1.`));
    expect(r.failures[0]!.excerpt).not.toContain("hunter2hunter2");
    expect(r.failures[0]!.excerpt).not.toContain("sk-abcdef");
  });
  test("ordinary assertion text survives", () => {
    expect(redact("Expected: 4\nReceived: 5 at board.test.ts:99:30")).toBe("Expected: 4\nReceived: 5 at board.test.ts:99:30");
  });
});

describe("signature", () => {
  test("the same failure on two runs matches although the time, address and path differ", () => {
    const a = signature("sync > retry", "TimeoutError: took 3.2s at /home/runner/work/a/a/x.ts (0x7f82ec)");
    const b = signature("sync > retry", "TimeoutError: took 20s at /home/runner/work/b/b/x.ts (0x1a2b3c)");
    expect(a).toBe(b);
  });
  test("a different assertion on the same test does not match", () => {
    expect(signature("t", "Expected: 4")).not.toBe(signature("t", "Received: undefined"));
  });
});

describe("annotations", () => {
  const A = (message: string, o: Record<string, unknown> = {}) => ({ level: "failure", path: ".github", line: 1, message, ...o });
  test("the exit-code line says a step failed, not what: it is not a failure here", () => {
    expect(annotationFailures([A("Process completed with exit code 1.")]).failures).toEqual([]);
  });
  test("warnings and notices are not failures", () => {
    expect(annotationFailures([A("Node 20 is deprecated", { level: "warning" }), A("cache saved", { level: "notice" })]).failures).toEqual([]);
  });
  test("an assertion with a file and a line is titled by where", () => {
    const r = annotationFailures([A("Expected: 4\nReceived: 5", { path: "server/test/board.test.ts", line: 99 })]);
    expect(r.failures[0]).toMatchObject({ kind: "annotation", title: "server/test/board.test.ts:99" });
    expect(r.failures[0]!.excerpt).toContain("Received: 5");
  });
  test("a message from nowhere is titled by its first line, and is redacted", () => {
    const r = annotationFailures([A("deploy failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789\nmore")]);
    expect(r.failures[0]!.title).toContain("deploy failed");
    expect(JSON.stringify(r)).not.toContain("ghp_abc");
  });
});

// ── the order of reads, and what is kept ───────────────────────────────────
function sources(o: { ann?: unknown; log?: unknown; out?: unknown } = {}) {
  const calls: string[] = [];
  const src: Src = {
    annotations: async () => { calls.push("annotations"); return (o.ann ?? { ok: true, items: [] }) as never; },
    log: async (max) => { calls.push(`log<=${max}`); return (o.log ?? { ok: true, text: BUN, bytes: BUN.length }) as never; },
    output: async () => { calls.push("output"); return (o.out ?? { ok: true, output: null }) as never; },
  };
  return { src, calls };
}
let n = 100;
const job = () => String(++n);

describe("readCheckFailures", () => {
  test("a cold read is one annotations call and one log call, and names the tests", async () => {
    const { src, calls } = sources();
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(calls).toEqual(["annotations", "log<=25000000"]);
    expect(r).toMatchObject({ ok: true, state: "read", source: "log", framework: "bun", cached: false, requests: 2 });
    if (r.ok) expect(r.failures.map((f) => f.title)).toContain("orbit board > keeps four lanes");
  });

  test("a second read costs nothing and says it came from the cache", async () => {
    const id = job();
    const first = sources();
    await readCheckFailures("github.com/acme/orbit", id, { attempt: 1 }, first.src);
    const second = sources();
    const r = await readCheckFailures("github.com/acme/orbit", id, { attempt: 1 }, second.src);
    expect(second.calls).toEqual([]);
    expect(r).toMatchObject({ ok: true, cached: true, requests: 0, state: "read" });
  });

  test("two opens at once make one pair of requests", async () => {
    const id = job();
    const { src, calls } = sources();
    await Promise.all([readCheckFailures("github.com/acme/orbit", id, {}, src), readCheckFailures("github.com/acme/orbit", id, {}, src)]);
    expect(calls).toEqual(["annotations", "log<=25000000"]);
  });

  test("another attempt or another repo is another read", async () => {
    const id = job();
    const a = sources();
    await readCheckFailures("github.com/acme/orbit", id, { attempt: 1 }, a.src);
    const b = sources();
    await readCheckFailures("github.com/acme/orbit", id, { attempt: 2 }, b.src);
    const c = sources();
    await readCheckFailures("github.com/acme/harbor", id, { attempt: 1 }, c.src);
    expect([a.calls.length, b.calls.length, c.calls.length]).toEqual([2, 2, 2]);
  });

  test("tests the log names win over annotations, which carry no test name", async () => {
    const { src } = sources({ ann: { ok: true, items: [{ level: "failure", path: "server/test/board.test.ts", line: 99, message: "Expected: 4" }] } });
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(r.ok && r.source).toBe("log");
  });

  test("annotations beat the tail of a step when the log names no test", async () => {
    const smoke = stamp(`##[group]Run npx eslint .\n##[endgroup]\nsome output\n##[error]Process completed with exit code 1.`);
    const { src } = sources({
      log: { ok: true, text: smoke, bytes: smoke.length },
      ann: { ok: true, items: [{ level: "failure", path: "web/src/board.ts", line: 12, message: "'lane' is assigned a value but never used" }] },
    });
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(r).toMatchObject({ ok: true, source: "annotations" });
    if (r.ok) expect(r.failures[0]!.title).toBe("web/src/board.ts:12");
  });

  test("no test, no annotation: the failing step, titled by the jobs API", async () => {
    const smoke = stamp(`##[group]Run make smoke\n##[endgroup]\nserver on http://localhost:4123\n##[error]Process completed with exit code 7.`);
    const { src } = sources({ log: { ok: true, text: smoke, bytes: smoke.length } });
    const r = await readCheckFailures("github.com/acme/orbit", job(), { step: "Smoke (production bundle)" }, src);
    expect(r).toMatchObject({ ok: true, source: "step", framework: "step" });
    if (r.ok) expect(r.failures[0]!.title).toBe("Smoke (production bundle)");
  });

  test("a log with nothing in it that looks like a failure is unparsed, not invented", async () => {
    const { src } = sources({ log: { ok: true, text: "all fine\nnothing here", bytes: 21 } });
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(r).toMatchObject({ ok: true, state: "unparsed", failures: [] });
  });

  test("an expired log keeps what GitHub's annotations kept, and is itself kept", async () => {
    const id = job();
    const { src } = sources({ log: { ok: false, kind: "expired" }, ann: { ok: true, items: [{ level: "failure", path: "web/src/board.ts", line: 12, message: "boom" }] } });
    const r = await readCheckFailures("github.com/acme/orbit", id, {}, src);
    expect(r).toMatchObject({ ok: true, state: "expired", source: "annotations" });
    const again = sources();
    expect(await readCheckFailures("github.com/acme/orbit", id, {}, again.src)).toMatchObject({ state: "expired", cached: true });
    expect(again.calls).toEqual([]);
  });

  test("too large says how large, is kept, and `force` reads it with a bigger cap", async () => {
    const id = job();
    const big = sources({ log: { ok: false, kind: "toolarge", bytes: 64_000_000 } });
    const r = await readCheckFailures("github.com/acme/orbit", id, {}, big.src);
    expect(r).toMatchObject({ ok: true, state: "toolarge", sizeBytes: 64_000_000, failures: [] });
    const forced = sources();
    const f = await readCheckFailures("github.com/acme/orbit", id, {}, forced.src, { force: true });
    expect(forced.calls).toEqual(["annotations", "log<=150000000"]);
    expect(f).toMatchObject({ ok: true, state: "read", cached: false });
    expect(storedFailures("github.com/acme/orbit", id, 1)).toMatchObject({ state: "read" });
  });

  test("a spent budget or a network error is shown and NOT kept: the next open tries again", async () => {
    const id = job();
    const spent = sources({ log: { ok: false, kind: "budget", resetAt: 1_790_000_000_000 } });
    expect(await readCheckFailures("github.com/acme/orbit", id, {}, spent.src)).toMatchObject({ ok: false, kind: "budget", resetAt: 1_790_000_000_000 });
    const broken = sources({ ann: { ok: false, kind: "error", error: "connection reset" } });
    expect(await readCheckFailures("github.com/acme/orbit", id, {}, broken.src)).toMatchObject({ ok: false, kind: "error", error: "connection reset" });
    expect(broken.calls).toEqual(["annotations"]); // no log read after the annotations failed
    const ok = sources();
    expect(await readCheckFailures("github.com/acme/orbit", id, {}, ok.src)).toMatchObject({ ok: true, cached: false });
  });

  test("what is stored is the redacted text, and 90 days later it is gone", async () => {
    const id = job();
    const leak = stamp(`error: bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n(fail) uses jane@example.com [1ms]`);
    const { src } = sources({ log: { ok: true, text: leak, bytes: leak.length } });
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await readCheckFailures("github.com/acme/orbit", id, {}, src, { now: t0 });
    const raw = JSON.stringify(db.prepare(`SELECT * FROM ci_failure_items WHERE job_id = ?`).all(id));
    expect(raw).not.toContain("ghp_abc");
    expect(raw).not.toContain("jane@");
    // a later read, 91 days on, prunes it
    const other = sources();
    await readCheckFailures("github.com/acme/orbit", job(), {}, other.src, { now: t0 + 91 * 86_400_000 });
    expect(db.prepare(`SELECT count(*) AS n FROM ci_failure_items WHERE job_id = ?`).get(id)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM ci_failure_reads WHERE job_id = ?`).get(id)).toEqual({ n: 0 });
  });
});

// ── a check an app posted: no job log, only its own output ─────────────────
const GATE = { title: "Critical file requirements not met", summary: "❌ Core: missing checklist item: \"Add a performance item to Testing Criteria\"", text: "" };

describe("outputFailures", () => {
  test("the title and the summary are the failure", () => {
    const r = outputFailures(GATE);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ kind: "output", title: "Critical file requirements not met" });
    expect(r.failures[0]!.excerpt).toContain("missing checklist item");
  });
  test("summary and text are kept together, in that order", () => {
    const r = outputFailures({ title: "t", summary: "first", text: "second" });
    expect(r.failures[0]!.excerpt).toBe("first\n\nsecond");
  });
  test("a check that wrote nothing has no failure to show", () => {
    expect(outputFailures({ title: "", summary: "  ", text: "" }).failures).toEqual([]);
  });
  test("what an app wrote is redacted like a log", () => {
    const r = outputFailures({ title: "deploy gate", summary: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for jane@example.com", text: "" });
    expect(JSON.stringify(r)).not.toContain("ghp_abc");
    expect(JSON.stringify(r)).not.toContain("jane@");
  });
  test("a long summary is capped, keeping both ends", () => {
    const r = outputFailures({ title: "t", summary: `start\n${"x".repeat(10_000)}\nend`, text: "" });
    expect(r.failures[0]!.truncated).toBe(true);
    expect(r.failures[0]!.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT + 20);
  });
});

describe("readCheckFailures when there is no job log", () => {
  test("a 404 on the log is a check an app posted: its own output is shown, in three requests", async () => {
    const { src, calls } = sources({ log: { ok: false, kind: "notfound" }, out: { ok: true, output: GATE } });
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(calls).toEqual(["annotations", "log<=25000000", "output"]);
    expect(r).toMatchObject({ ok: true, state: "nolog", source: "output", requests: 3 });
    if (r.ok) expect(r.failures[0]).toMatchObject({ kind: "output", title: "Critical file requirements not met" });
  });

  test("it is kept: opened again it costs nothing", async () => {
    const id = job();
    await readCheckFailures("github.com/acme/orbit", id, {}, sources({ log: { ok: false, kind: "notfound" }, out: { ok: true, output: GATE } }).src);
    const again = sources();
    const r = await readCheckFailures("github.com/acme/orbit", id, {}, again.src);
    expect(again.calls).toEqual([]);
    expect(r).toMatchObject({ state: "nolog", source: "output", cached: true });
  });

  test("annotations are enough: the output is not asked for", async () => {
    const { src, calls } = sources({ log: { ok: false, kind: "notfound" }, ann: { ok: true, items: [{ level: "failure", path: "web/src/board.ts", line: 12, message: "boom" }] } });
    const r = await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(calls).toEqual(["annotations", "log<=25000000"]);
    expect(r).toMatchObject({ ok: true, state: "nolog", source: "annotations" });
  });

  test("a check with no log and no output says so, with nothing invented", async () => {
    const { src } = sources({ log: { ok: false, kind: "notfound" }, out: { ok: true, output: null } });
    expect(await readCheckFailures("github.com/acme/orbit", job(), {}, src)).toMatchObject({ ok: true, state: "nolog", source: "none", failures: [] });
  });

  test("an expired log falls back to the output too: it outlives the 90 days", async () => {
    const { src } = sources({ log: { ok: false, kind: "expired" }, out: { ok: true, output: GATE } });
    expect(await readCheckFailures("github.com/acme/orbit", job(), {}, src)).toMatchObject({ ok: true, state: "expired", source: "output" });
  });

  test("too large is not a reason to ask for the output: the log is there", async () => {
    const { src, calls } = sources({ log: { ok: false, kind: "toolarge", bytes: 64_000_000 } });
    await readCheckFailures("github.com/acme/orbit", job(), {}, src);
    expect(calls).not.toContain("output");
  });

  test("a spent budget on the output read is shown and not kept", async () => {
    const id = job();
    const { src } = sources({ log: { ok: false, kind: "notfound" }, out: { ok: false, kind: "budget", resetAt: 1_790_000_000_000 } });
    expect(await readCheckFailures("github.com/acme/orbit", id, {}, src)).toMatchObject({ ok: false, kind: "budget" });
    expect(storedFailures("github.com/acme/orbit", id, 1)).toBeNull();
  });
});
