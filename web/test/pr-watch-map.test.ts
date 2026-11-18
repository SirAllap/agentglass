/*
 * The run map behind the Notify popover: how a PR's checks become squares in
 * families, what the green card counts, what is suggested to skip, and where the
 * popover sits. Names are invented but shaped like a monorepo's CI.
 */
import { describe, expect, it } from "bun:test";
import { checkFamilies, checksPageUrl, failKind, failRuleOf, fmtMs, ignoredFailures, onlyRequiredIgnore, rerunCommand, runChecks, splitCheck, suggestSkips, waitTally, type RunCheck } from "../src/lib/prWatchStore.ts";
import { placePop, TIGHT_BELOW } from "../src/lib/prWatchPlace.ts";
import type { PrCheck } from "../../shared/types.ts";

const chk = (name: string, o: Partial<PrCheck> = {}): PrCheck => ({ name, workflow: "CI", state: "success", done: true, ...o });
const rc = (name: string, state: RunCheck["state"] = "pass"): RunCheck => ({ name, state });

describe("runChecks", () => {
  it("maps states, one square per name, the most pressing run wins", () => {
    const out = runChecks([
      chk("lint"), chk("unit", { state: "pending", done: false, startedAt: "2026-01-01T00:00:00Z" }), chk("e2e", { state: "pending", done: false }),
      chk("docs", { state: "skipped" }), chk("build", { state: "failure" }), chk("build", { event: "push" }),
      chk("deploy", { state: "failure", cancelled: true }),
    ]);
    expect(Object.fromEntries(out.map((c) => [c.name, c.state]))).toEqual({ lint: "pass", unit: "run", e2e: "queue", docs: "skip", build: "fail", deploy: "queue" });
  });
  it("carries the duration of a finished run", () => {
    expect(runChecks([chk("a", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:03:12Z" })])[0]!.ms).toBe(192000);
    expect(fmtMs(192000)).toBe("3m 12s");
    expect(fmtMs(9000)).toBe("9s");
  });
});

describe("checkFamilies", () => {
  it("groups `name (args)` by the text before the paren, whatever the args hold", () => {
    const f = checkFamilies([rc("cov (api, coverage.xml, src/api)"), rc("cov (gw, a.xml, src/gw)"), rc("pyright (api)"), rc("pyright (gw)"), rc("pyright (rt)")]);
    expect(f.map((x) => [x.key, x.members.length])).toEqual([["pyright", 3], ["cov", 2]]);
  });
  it("a name with one paren member stays flat, in 'other jobs', last", () => {
    const f = checkFamilies([rc("lint (web)"), rc("guard"), rc("unit (a)"), rc("unit (b)")]);
    expect(f.map((x) => x.key)).toEqual(["unit", "other jobs"]);
    expect(f[1]!.members.map((m) => m.name)).toEqual(["lint (web)", "guard"]);
  });
  it("a first word shared by three becomes word-*; two do not", () => {
    const f = checkFamilies([rc("check-a"), rc("check-b"), rc("check-c"), rc("docker-x"), rc("docker-y"), rc("select")]);
    expect(f.map((x) => x.key)).toEqual(["check-*", "other jobs"]);
    expect(f[1]!.members).toHaveLength(3);
  });
  it("names with no args and no dash are just other jobs", () => {
    expect(checkFamilies([rc("guard"), rc("select")]).map((x) => x.key)).toEqual(["other jobs"]);
    expect(checkFamilies([])).toEqual([]);
  });
});

describe("waitTally", () => {
  const all = [rc("a"), rc("b"), rc("c", "run"), rc("d", "queue"), rc("e", "fail"), rc("f", "skip")];
  it("counts only what is waited for; skipped never reports", () => {
    expect(waitTally(all, [])).toEqual({ pass: 2, run: 2, fail: 1, waitFor: 5, reqSkipped: 0 });
  });
  it("leaves out the ignored names", () => {
    expect(waitTally(all, ["e", "c"])).toEqual({ pass: 2, run: 1, fail: 0, waitFor: 3, reqSkipped: 0 });
    expect(waitTally(all, all.map((c) => c.name))).toEqual({ pass: 0, run: 0, fail: 0, waitFor: 0, reqSkipped: 0 });
  });
});

describe("suggestSkips", () => {
  const r = (name: string, state: RunCheck["state"], required?: boolean): RunCheck => ({ name, state, ...(required === undefined ? null : { required }) });
  it("never offers a required check, skipped or not", () => {
    expect(suggestSkips([r("a", "skip", true), r("b", "pass", true)], ["a", "b"])).toEqual([]);
  });
  it("an unknown-required check is offered only when it did not run", () => {
    expect(suggestSkips([r("docs", "skip"), r("fine", "pass"), r("flaky", "fail")], ["fine", "flaky"])).toEqual(["docs"]);
  });
  it("a check known not to be required also comes back from the repo default's ignores", () => {
    expect(suggestSkips([r("x", "pass", false), r("y", "pass", false), r("z", "skip", false)], ["x"])).toEqual(["x", "z"]);
  });
  it("nothing to suggest on a clean run", () => {
    expect(suggestSkips([r("a", "pass")])).toEqual([]);
  });
  it("runChecks carries required, true wins across runs of one name, and the tally counts required ones not waited for", () => {
    const out = runChecks([chk("lint", { required: false }), chk("lint", { event: "push", required: true }), chk("u")]);
    expect(out.find((c) => c.name === "lint")!.required).toBe(true);
    expect(out.find((c) => c.name === "u")!.required).toBeUndefined();
    expect(waitTally(out, ["lint"]).reqSkipped).toBe(1);
    expect(waitTally(out, ["u"]).reqSkipped).toBe(0);
  });
});

describe("check names", () => {
  it("the search row shows the first argument in full with the family dimmed", () => {
    expect(splitCheck("frontend-analysis (admin, src/web/admin, true)")).toEqual({ family: "frontend-analysis", arg: "admin" });
    expect(splitCheck("guard")).toBeNull();
  });
  it("'tell me if it fails' is the exact-name check rule", () => {
    expect(failRuleOf("evals (smoke)")).toEqual({ type: "check", match: "evals (smoke)", on: "fail" });
  });
});

describe("placePop", () => {
  it("opens below with the room under the button minus 12px and the gap", () => {
    expect(placePop({ top: 20, bottom: 50 }, 900)).toEqual({ up: false, maxHeight: 900 - 50 - 6 - 12, tight: false });
  });
  it("flips up when there is more room above", () => {
    const p = placePop({ top: 700, bottom: 730 }, 800);
    expect(p).toEqual({ up: true, maxHeight: 700 - 6 - 12, tight: false });
  });
  it("stops above a floating box that sits under the button in the popover's columns, and ignores one beside it", () => {
    const btn = { top: 88, bottom: 110, right: 1388 };
    const fab = { left: 1363, top: 774, right: 1401, bottom: 810 };
    expect(placePop(btn, 900, [fab]).maxHeight).toBe(774 - 110 - 6 - 12);
    expect(placePop(btn, 900, [{ ...fab, left: 100, right: 138 }]).maxHeight).toBe(900 - 110 - 6 - 12);
  });
  it("is tight under the threshold and never smaller than a card", () => {
    expect(placePop({ top: 20, bottom: 50 }, 440).tight).toBe(true);
    expect(placePop({ top: 20, bottom: 50 }, 50 + 6 + 12 + TIGHT_BELOW).tight).toBe(false);
    expect(placePop({ top: 20, bottom: 50 }, 90).maxHeight).toBe(180);
  });
});

describe("only-required preset, flake warning, re-run shortcut", () => {
  it("preset skips only checks known not required", () => {
    const r = (name: string, required?: boolean): RunCheck => ({ name, state: "pass", ...(required !== undefined ? { required } : null) });
    expect(onlyRequiredIgnore([r("build", true), r("perf", false), r("docs"), r("lint", false)])).toEqual(["perf", "lint"]);
  });
  it("tells a runner flake from a real finding among ignored red checks", () => {
    expect(failKind({ title: "fatal: expected 'packfile'" })).toBe("flake");
    expect(failKind({ title: "error: RPC failed; HTTP 408" })).toBe("flake");
    expect(failKind({ title: "2 slow queries found" })).toBe("real");
    expect(failKind({})).toBe("unknown");
    const all = [chk("perf", { state: "failure", title: "HTTP 408" }), chk("lint", { state: "failure", title: "unused import" }), chk("unit", { state: "failure", title: "HTTP 408" })];
    expect(ignoredFailures(all, ["perf", "lint"]).map((f) => [f.name, f.kind])).toEqual([["perf", "flake"], ["lint", "real"]]);
  });
  it("same-name checks: a real finding is not hidden by a flake run, and HTTP 4080 is no flake", () => {
    const all = [chk("perf", { state: "failure", title: "HTTP 408" }), chk("perf", { state: "failure", title: "2 slow queries found" })];
    expect(ignoredFailures(all, ["perf"]).map((f) => [f.name, f.kind])).toEqual([["perf", "real"]]);
    expect(failKind({ title: "HTTP 4080 rows" })).toBe("real");
  });
  it("re-run only builds text or a link, never runs anything", () => {
    expect(rerunCommand("acme/orbit", "https://github.com/acme/orbit/actions/runs/4242/job/9")).toBe("gh run rerun 4242 --failed -R acme/orbit");
    expect(rerunCommand("acme/orbit", undefined)).toBeNull();
    expect(checksPageUrl("acme/orbit", 7)).toBe("https://github.com/acme/orbit/pull/7/checks");
  });
});

describe("copy re-run: a clipboard failure is told", () => {
  it("the menu shows its failure note when the clipboard is missing or refuses", async () => {
    const src = await Bun.file(new URL("../src/components/PrWatchMenu.tsx", import.meta.url)).text();
    expect(src).toContain('setErr("could not copy the command")');
    expect(src).not.toMatch(/writeText\(cmd\)[^\n]*catch\(\(\) => \{\}\)/);
  });
});
