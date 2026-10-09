/*
 * What the Checks tab says about a failed check's failures. The decisions are
 * functions (lib/checkFailures.ts), the requests are a store with its reads
 * handed in, and the screen is asserted against its source: there is no
 * renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import type { CheckFailures, CiFailure, PrCheck } from "../../shared/types.ts";
import { failedInRun, fileFact, fileFactLabel, isAggregator, testFiles, othersShape, unknownPrs, failureGist, failureRowText, failureView, failureCopyText, formatBytes, jobFor, logAgeDays, plural, readLine, resetClock } from "../src/lib/checkFailures.ts";
import { makeFailureStore } from "../src/lib/checkFailuresStore.ts";

const F = (title: string, excerpt: string, kind: CiFailure["kind"] = "bun"): CiFailure => ({ kind, title, excerpt, signature: `${title} :: x`, truncated: false });
const read = (o: Partial<Extract<CheckFailures, { ok: true }>> = {}): Extract<CheckFailures, { ok: true }> => ({
  ok: true, state: "read", source: "log", framework: "bun", failures: [F("orbit board > keeps four lanes", "error: expect(received).toBe(expected)\n\nExpected: 4\nReceived: 5")],
  more: 0, verdicts: [{ kind: "this-pr" }], readBytes: 1_153_433, at: 0, cached: false, requests: 2, ...o,
});

describe("the row says what the failure is, or nothing", () => {
  test("tests, errors, one and many", () => {
    expect(failureRowText({ source: "log", count: 2, more: 0 })).toBe("2 failing tests");
    expect(failureRowText({ source: "log", count: 1, more: 0 })).toBe("1 failing test");
    expect(failureRowText({ source: "log", count: 10, more: 4 })).toBe("14 failing tests");
    expect(failureRowText({ source: "annotations", count: 3, more: 0 })).toBe("3 errors");
  });
  test("a step's tail is not a count of anything: the row keeps the words it had", () => {
    expect(failureRowText({ source: "step", count: 1, more: 0 })).toBeNull();
    expect(failureRowText({ source: "none", count: 0, more: 0 })).toBeNull();
    expect(failureRowText({ source: "log", count: 0, more: 0 })).toBeNull();
  });
});

describe("one answer, one screen", () => {
  test("nothing yet is loading", () => expect(failureView(undefined)).toEqual({ kind: "loading" }));
  test("a failure list wins over the reason the log was not read", () => {
    const v = failureView(read({ state: "expired", source: "annotations", readBytes: 0 }));
    expect(v).toMatchObject({ kind: "failures", notice: "expired" });
  });
  test("a step's tail is the no-test screen", () => {
    expect(failureView(read({ source: "step", framework: "step", failures: [F("Smoke", "Process completed with exit code 7.", "step")] })).kind).toBe("no-test");
  });
  test("expired and too large with nothing kept are their own screens", () => {
    expect(failureView(read({ state: "expired", source: "none", failures: [], readBytes: 0 })).kind).toBe("expired");
    expect(failureView(read({ state: "toolarge", source: "none", failures: [], readBytes: 0, sizeBytes: 64_000_000 }))).toMatchObject({ kind: "toolarge", size: 64_000_000, canForce: true });
  });
  test("a log over what the server will ever take offers no 'Read it anyway'", () => {
    expect(failureView(read({ state: "toolarge", source: "none", failures: [], sizeBytes: 400_000_000 }))).toMatchObject({ canForce: false });
  });
  test("read, and nothing in it: not recognised, not an invented failure", () => {
    expect(failureView(read({ state: "unparsed", source: "none", failures: [] })).kind).toBe("unparsed");
  });
  test("a check an app posted shows its own message, whether it never had a log or the log expired", () => {
    const msg = F("Critical file requirements not met", "missing checklist item", "output");
    expect(failureView(read({ state: "nolog", source: "output", framework: null, failures: [msg], readBytes: 0 }))).toMatchObject({ kind: "output", why: "nolog" });
    expect(failureView(read({ state: "expired", source: "output", framework: null, failures: [msg], readBytes: 0 }))).toMatchObject({ kind: "output", why: "expired" });
  });
  test("no log and no message: its own screen, not an error", () => {
    expect(failureView(read({ state: "nolog", source: "none", framework: null, failures: [], readBytes: 0 })).kind).toBe("nolog");
  });
  test("annotations on a check with no log are still a failure list", () => {
    expect(failureView(read({ state: "nolog", source: "annotations", framework: null, failures: [F("web/src/board.ts:12", "boom", "annotation")], readBytes: 0 })).kind).toBe("failures");
  });
  test("a job GitHub holds no log for says so, with what its annotations kept, or with nothing", () => {
    const runner = F("The self-hosted runner lost communication with the server.", "Verify the machine is running", "annotation");
    expect(failureView(read({ state: "unlogged", source: "annotations", framework: null, failures: [runner], readBytes: 0 }))).toMatchObject({ kind: "failures", notice: "unlogged" });
    expect(failureView(read({ state: "unlogged", source: "none", framework: null, failures: [], readBytes: 0 })).kind).toBe("unlogged");
    expect(failureView(read({ state: "unlogged", source: "output", framework: null, failures: [F("t", "m", "output")], readBytes: 0 }))).toMatchObject({ kind: "output", why: "unlogged" });
  });
  test("a spent budget carries the time it comes back; an error carries its words", () => {
    expect(failureView({ ok: false, kind: "budget", resetAt: 1_790_000_000_000, requests: 1 })).toEqual({ kind: "budget", resetAt: 1_790_000_000_000 });
    expect(failureView({ ok: false, kind: "error", error: "boom", requests: 1 })).toEqual({ kind: "error", error: "boom" });
  });
});

describe("words", () => {
  test("bytes", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(1_153_433)).toBe("1.2 MB");
    expect(formatBytes(64_000_000)).toBe("64 MB");
  });
  test("what was read and what was kept", () => {
    expect(readLine(read())).toMatch(/^Read 1\.2 MB of log, kept \d/);
    expect(readLine(read({ source: "annotations", readBytes: 0 }))).toBe("From GitHub's annotations");
  });
  test("the gist is the first thing the tool said, short, without the line-number gutter", () => {
    expect(failureGist(F("t", " 98 |   const lanes = board.lanes();\n 99 |   expect(lanes.length).toBe(4);\n   ^\nerror: expect(received).toBe(expected)"))).toBe("expect(received).toBe(expected)");
    expect(failureGist(F("t", `error: ${"x".repeat(80)}`), 20)).toHaveLength(20);
  });
  test("copy gives the name and exactly what the panel shows", () => {
    expect(failureCopyText(F("orbit board > keeps four lanes", "Expected: 4\nReceived: 5\n"))).toBe("orbit board > keeps four lanes\n\nExpected: 4\nReceived: 5");
  });
  test("age and clock", () => {
    expect(logAgeDays("2026-06-01T00:00:00Z", Date.parse("2026-09-21T00:00:00Z"))).toBe(112);
    expect(logAgeDays(undefined)).toBeNull();
    expect(resetClock(null)).toBeNull();
    expect(resetClock(new Date(2026, 9, 1, 14, 5).getTime())).toBe("14:05");
    expect(plural(1, "day")).toBe("1 day");
  });
  test("a check finds its job by the id in its own URL, which cannot name the wrong job", () => {
    const jobs = [{ id: "11", name: "Tests / vart-evals" }, { id: "12", name: "vart-evals" }] as never[];
    // the name alone would pick job 12, whose name matches: the URL says 11
    expect(jobFor({ name: "vart-evals", url: "https://github.com/acme/orbit/actions/runs/9/job/11" }, jobs)?.id).toBe("11");
  });
  test("a job the capped list does not hold is made from the URL: the panel is never silently absent", () => {
    const j = jobFor({ name: "vart-evals", url: "https://github.com/acme/orbit/actions/runs/9/job/777", startedAt: "2026-10-01T10:00:00Z" }, [{ id: "1", name: "build" }] as never[]);
    expect(j).toMatchObject({ id: "777", runId: "9", name: "vart-evals", url: "https://github.com/acme/orbit/actions/runs/9/job/777", startedAt: "2026-10-01T10:00:00Z" });
  });
  test("without an id in the link, the old name rules still apply", () => {
    const jobs = [{ id: "1", name: "build" }, { id: "2", name: "Sidecar (macos-latest)" }] as never[];
    expect(jobFor({ name: "build" }, jobs)?.id).toBe("1");
    expect(jobFor({ name: "CI / Sidecar (macos-latest)" }, jobs)?.id).toBe("2");
  });
  test("a check an app posted names a check run, not a job: that id is what is read", () => {
    expect(jobFor({ name: "Docs gate", url: "https://github.com/acme/orbit/runs/4242" }, [])).toMatchObject({ id: "4242", runId: "" });
  });
  test("a check that names nothing has no job, and the screen says so", () => {
    expect(jobFor({ name: "deploy" }, [{ id: "1", name: "build" }] as never[])).toBeUndefined();
    expect(jobFor({ name: "deploy", url: "https://example.com/status" }, [])).toBeUndefined();
  });
});

describe("the store asks once, and only when told to", () => {
  const mk = (answers: CheckFailures[] = [read()]) => {
    const calls: string[] = [];
    let i = 0;
    const store = makeFailureStore({
      failures: async (_r, job, _h, force) => { calls.push(`failures ${job}${force ? " force" : ""}`); return answers[Math.min(i++, answers.length - 1)]!; },
      cached: async (_r, jobs) => { calls.push(`cached ${jobs.join(",")}`); return { ok: true, summaries: { "1": { state: "read", source: "log", count: 2, more: 0, titles: ["a", "b"], verdicts: [{ kind: "this-pr" }, { kind: "this-pr" }] } } }; },
    });
    return { store, calls };
  };
  test("two opens at once, then a third, are one request", async () => {
    const { store, calls } = mk();
    await Promise.all([store.load("r", "1", {}), store.load("r", "1", {})]);
    await store.load("r", "1", {});
    expect(calls).toEqual(["failures 1"]);
    expect(store.readOf("r#1")?.ok).toBe(true);
  });
  test("a budget or network answer is shown and the next open asks again", async () => {
    const { store, calls } = mk([{ ok: false, kind: "budget", resetAt: null, requests: 1 }, read()]);
    await store.load("r", "1", {});
    expect(store.readOf("r#1")).toMatchObject({ ok: false, kind: "budget" });
    await store.load("r", "1", {});
    expect(store.readOf("r#1")?.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
  test("'Read it anyway' asks again with force, over a kept answer", async () => {
    const { store, calls } = mk([read({ state: "toolarge", source: "none", failures: [], sizeBytes: 64_000_000 }), read()]);
    await store.load("r", "1", {});
    await store.load("r", "1", {}, true);
    expect(calls).toEqual(["failures 1", "failures 1 force"]);
  });
  test("a thrown request becomes an error answer, not a crash", async () => {
    const store = makeFailureStore({ failures: async () => { throw new Error("offline"); }, cached: async () => ({ ok: false }) });
    await store.load("r", "1", {});
    expect(store.readOf("r#1")).toMatchObject({ ok: false, kind: "error" });
  });
  test("the rows ask the cache once per job, however often they render", async () => {
    const { store, calls } = mk();
    await store.loadCached("r", ["1", "2"]);
    await store.loadCached("r", ["1", "2"]);
    await store.loadCached("r", ["2", "3"]);
    expect(calls).toEqual(["cached 1,2", "cached 3"]);
    expect(store.summaryOf("r#1")).toMatchObject({ count: 2 });
  });
  test("a job already read in this session is not asked of the cache", async () => {
    const { store, calls } = mk();
    await store.load("r", "1", {});
    await store.loadCached("r", ["1"]);
    expect(calls).toEqual(["failures 1"]);
  });
});

const src = await Bun.file(new URL("../src/components/CheckFailures.tsx", import.meta.url)).text();
const prPanel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("the screen, against its source", () => {
  const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  test("the way out is drawn once, in the footer every state shares; only its words change", () => {
    // one footer component, used by the panel and by the no-job card: the link itself is drawn in one place
    expect(code(src).split("function Footer(").length - 1).toBe(1);
    expect(code(src).split("<a href={href}").length - 1).toBe(1);
  });
  test("opening the check is the only thing that asks: the effect that loads is keyed on the job, not on a timer", () => {
    expect(code(src)).not.toMatch(/setInterval|setTimeout\([^)]*load\(/);
    expect(src).toMatch(/useEffect\(\(\) => \{ void load\(root, job\.id, hints\); \}, \[root, job\.id\]\)/);
  });
  test("the panel is mounted for every expanded failed check, with or without a job: it always says something", () => {
    expect(prPanel).toMatch(/\{expanded && <CheckFailuresPanel root=\{root\} check=\{k\} job=\{jobFor\(k, jobs\)\}\s+sameRun=\{failedInRun\(k, d\.checksAll\)/);
    expect(src).toContain("This check does not say which job ran it");
  });
  test("an aggregator says what it is and names the failed jobs; the raw tail stays one click away", () => {
    for (const w of ["This job only reports the others", "Failed in this run:", "Show the end of the step", "Reports the others"]) expect(src).toContain(w);
    // the names open that check's detail, in this tab: the panel is handed the opener, it does not reach for the row itself
    expect(src).toContain("onClick={k.open}");
    expect(prPanel).toContain("openSibling(checkRowId(o))");
  });
  test("every state in the mockup has its words", () => {
    for (const w of ["GitHub holds no log for this job", "Nothing to read", "Open on GitHub", "Posted by an app", "This check has no log", "Log expired", "Too large", "No test named", "Budget spent", "Read it anyway", "Reading the log…", "GitHub no longer has this log", "GitHub’s hourly budget is used up", "The log names no failing test"]) expect(src).toContain(w);
  });
  test("surfaces and borders are the house's: tokens and EDGE/LINE, no raw colour", () => {
    expect(code(src)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|var\(--bg2\)/);
    expect(src).toContain("var(--surface-card)");
    expect(src).toContain("var(--surface-inset)");
  });
});

describe("a job that only reports the others", () => {
  const sum = (excerpt: string) => F("summary", excerpt, "step");
  test("the sentence and the exit code, and nothing else, is an aggregator", () => {
    expect(isAggregator(sum("One or more jobs failed or were cancelled\n##[error]Process completed with exit code 1."))).toBe(true);
    expect(isAggregator(sum("Some jobs were cancelled\nProcess completed with exit code 1."))).toBe(true);
  });
  test("one more line, or a named test, is not", () => {
    expect(isAggregator(sum("One or more jobs failed or were cancelled\nlint: 3 problems\nProcess completed with exit code 1."))).toBe(false);
    expect(isAggregator(sum("Process completed with exit code 1."))).toBe(true);
    expect(isAggregator(F("t", "Process completed with exit code 1.", "bun"))).toBe(false);
    expect(isAggregator(sum(""))).toBe(false);
  });
  const K = (name: string, run: string, job: string, state: PrCheck["state"] = "failure", more: Partial<PrCheck> = {}): PrCheck =>
    ({ name, workflow: "ci", state, done: true, url: `https://github.com/acme/orbit/actions/runs/${run}/job/${job}`, ...more });
  test("the failed checks of the same run, not itself, not another run, not a pass or a cancel", () => {
    const me = K("summary", "10", "1");
    const all = [me, K("server tests", "10", "2"), K("web tests", "10", "3"), K("lint", "10", "4", "success"), K("e2e", "11", "5"), K("smoke", "10", "6", "failure", { cancelled: true })];
    expect(failedInRun(me, all).map((k) => k.name)).toEqual(["server tests", "web tests"]);
  });
  test("a check with no run in its link names none", () => {
    expect(failedInRun({ url: "https://example.com/x" }, [K("a", "10", "2")])).toEqual([]);
    expect(failedInRun({}, [K("a", "10", "2")])).toEqual([]);
  });
});

describe("which pull request a failure also failed on", () => {
  test("one known pull request is a chip that opens it; several, or one plus an unknown run, are a list", () => {
    expect(othersShape({ nums: [475] })).toEqual({ kind: "one", n: 475 });
    expect(othersShape({ nums: [475, 471] })).toEqual({ kind: "list", nums: [475, 471], unknown: 0 });
    expect(othersShape({ nums: [475], unknown: 1 })).toEqual({ kind: "list", nums: [475], unknown: 1 });
  });
  test("a verdict kept before the numbers existed names none: words only, never a guess", () => {
    expect(othersShape({})).toEqual({ kind: "plain" });
    expect(othersShape({ nums: [], unknown: 2 })).toEqual({ kind: "plain" });
  });
  test("the unknown runs are said, singular and plural", () => {
    expect(unknownPrs(1)).toBe("1 more, PR unknown");
    expect(unknownPrs(3)).toBe("3 more, PRs unknown");
  });
  test("the screen opens a pull request inside the app, from the chip and from every row of the list", () => {
    const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code(src)).toContain("openPr(refs.repo, shape.n)");
    expect(code(src)).toContain("openPr(refs.repo, n)");
    expect(code(src)).not.toMatch(/window\.open|target="_blank"[^>]*pull/);
    expect(prPanel).toContain("refs={prRefs}");
  });
});

describe("is the failing test's file in this pull request's diff", () => {
  const all = (...paths: string[]) => ({ paths, complete: true });
  const py = F("TestBoard.test_lane_count", "FAILED tests/test_board.py::TestBoard::test_lane_count - assert 5 == 4", "pytest");
  const pyBlock = F("TestBoard.test_lane_count", "E  assert 5 == 4\n\ntests/test_board.py:12: AssertionError", "pytest");
  const bun = F("orbit board > keeps four lanes", "      at <anonymous> (/home/runner/work/orbit/orbit/server/test/board.test.ts:99:30)", "bun");
  const dj = F("test_ordering (orbit.tests.test_cards.CardTests.test_ordering)", "AssertionError: Lists differ", "django");
  test("where each runner puts the file", () => {
    expect(testFiles(py)).toEqual(["tests/test_board.py"]);
    expect(testFiles(pyBlock)).toEqual(["tests/test_board.py"]);
    expect(testFiles(bun)).toEqual(["/home/runner/work/orbit/orbit/server/test/board.test.ts"]);
    // class and method are unknown to us, so the module is the dotted name minus two parts, or minus one (a module-level test)
    expect(testFiles(dj)).toEqual(["orbit/tests/test_cards.py", "orbit/tests/test_cards/CardTests.py"]);
    expect(testFiles(F("Smoke", "Process completed with exit code 7.", "step"))).toEqual([]);
  });
  test("changed: a log's absolute path and the diff's relative one are the same file", () => {
    expect(fileFact(bun, all("server/test/board.test.ts"))).toEqual({ kind: "changed", path: "/home/runner/work/orbit/orbit/server/test/board.test.ts" });
    expect(fileFact(py, all("backend/tests/test_board.py"))).toEqual({ kind: "changed", path: "tests/test_board.py" });
    expect(fileFact(dj, all("backend/orbit/tests/test_cards.py"))).toMatchObject({ kind: "changed" });
  });
  test("a name that merely ends alike is not the file", () => {
    expect(fileFact(py, all("backend/xtests/test_board.py"))).toEqual({ kind: "untouched", path: "tests/test_board.py" });
  });
  test("not in the diff is said only when the whole diff was loaded", () => {
    expect(fileFact(py, all("README.md"))).toEqual({ kind: "untouched", path: "tests/test_board.py" });
    expect(fileFact(py, { paths: ["README.md"], complete: false })).toBeNull();
    expect(fileFact(py, { paths: ["tests/test_board.py"], complete: false })).toMatchObject({ kind: "changed" });
  });
  test("no file named, or no diff to compare: no fact", () => {
    expect(fileFact(F("Smoke", "Process completed with exit code 7.", "step"), all("a.py"))).toBeNull();
    expect(fileFact(py, undefined)).toBeNull();
  });
  test("the words say what was seen", () => {
    expect(fileFactLabel({ kind: "changed", path: "a" })).toBe("Test file changed in this PR");
    expect(fileFactLabel({ kind: "untouched", path: "a" })).toBe("Test file not in this PR’s diff");
  });
});
