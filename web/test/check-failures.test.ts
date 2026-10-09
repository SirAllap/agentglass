/*
 * What the Checks tab says about a failed check's failures. The decisions are
 * functions (lib/checkFailures.ts), the requests are a store with its reads
 * handed in, and the screen is asserted against its source: there is no
 * renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import type { CheckFailures, CiFailure } from "../../shared/types.ts";
import { failureGist, failureRowText, failureView, failureCopyText, formatBytes, jobFor, logAgeDays, plural, readLine, resetClock } from "../src/lib/checkFailures.ts";
import { makeFailureStore } from "../src/lib/checkFailuresStore.ts";

const F = (title: string, excerpt: string, kind: CiFailure["kind"] = "bun"): CiFailure => ({ kind, title, excerpt, signature: `${title} :: x`, truncated: false });
const read = (o: Partial<Extract<CheckFailures, { ok: true }>> = {}): Extract<CheckFailures, { ok: true }> => ({
  ok: true, state: "read", source: "log", framework: "bun", failures: [F("orbit board > keeps four lanes", "error: expect(received).toBe(expected)\n\nExpected: 4\nReceived: 5")],
  more: 0, readBytes: 1_153_433, at: 0, cached: false, requests: 2, ...o,
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
  test("a check finds its job by name, or by the job name inside a matrix name", () => {
    const jobs = [{ id: "1", name: "build" }, { id: "2", name: "Sidecar (macos-latest)" }] as never[];
    expect(jobFor({ name: "build" }, jobs)?.id).toBe("1");
    expect(jobFor({ name: "CI / Sidecar (macos-latest)" }, jobs)?.id).toBe("2");
    expect(jobFor({ name: "deploy" }, jobs)).toBeUndefined();
  });
});

describe("the store asks once, and only when told to", () => {
  const mk = (answers: CheckFailures[] = [read()]) => {
    const calls: string[] = [];
    let i = 0;
    const store = makeFailureStore({
      failures: async (_r, job, _h, force) => { calls.push(`failures ${job}${force ? " force" : ""}`); return answers[Math.min(i++, answers.length - 1)]!; },
      cached: async (_r, jobs) => { calls.push(`cached ${jobs.join(",")}`); return { ok: true, summaries: { "1": { state: "read", source: "log", count: 2, more: 0, titles: ["a", "b"] } } }; },
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
    expect(code(src).split("<Footer ").length - 1).toBe(1);
    expect(code(src).split("<a href={href}").length - 1).toBe(1);
  });
  test("opening the check is the only thing that asks: the effect that loads is keyed on the job, not on a timer", () => {
    expect(code(src)).not.toMatch(/setInterval|setTimeout\([^)]*load\(/);
    expect(src).toMatch(/useEffect\(\(\) => \{ void load\(root, job\.id, hints\); \}, \[root, job\.id\]\)/);
  });
  test("the panel is mounted only for an expanded failed check", () => {
    expect(prPanel).toMatch(/\{expanded && \(\(\) => \{ const job = jobFor\(k, jobs\); return job \? <CheckFailuresPanel/);
  });
  test("every state in the mockup has its words", () => {
    for (const w of ["Open on GitHub", "Posted by an app", "This check has no log", "Log expired", "Too large", "No test named", "Budget spent", "Read it anyway", "Reading the log…", "GitHub no longer has this log", "GitHub’s hourly budget is used up", "The log names no failing test"]) expect(src).toContain(w);
  });
  test("surfaces and borders are the house's: tokens and EDGE/LINE, no raw colour", () => {
    expect(code(src)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|var\(--bg2\)/);
    expect(src).toContain("var(--surface-card)");
    expect(src).toContain("var(--surface-inset)");
  });
});
