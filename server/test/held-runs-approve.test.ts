// "Approve workflows to run" against a fake GitHub: acme/orbit #322 by
// contributor-a, from a fork, with two runs held for a maintainer.
import { describe, expect, test } from "bun:test";
import { approveHeldRuns, readHeldRuns, type GhCall } from "../src/heldRunsGh.ts";

const SHA = "a".repeat(40);
const RUNS = JSON.stringify([
  { id: 9101, name: "build", status: "action_required", conclusion: null },
  { id: 9102, name: "catalogue", status: "completed", conclusion: "action_required" },
  { id: 9103, name: "labeler", status: "completed", conclusion: "success" },
]);

/** A GitHub that answers the head, the runs list, and each approve by `approve(id)`. */
function fakeGh(approve: (id: string) => { code: number; stderr?: string } = () => ({ code: 0 })) {
  const calls: string[][] = [];
  const call: GhCall = async (args) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (path === "repos/acme/orbit/pulls/322") return { code: 0, stdout: `${SHA}\n`, stderr: "" };
    if (path.startsWith(`repos/acme/orbit/actions/runs?head_sha=${SHA}`)) return { code: 0, stdout: RUNS, stderr: "" };
    const m = path.match(/^repos\/acme\/orbit\/actions\/runs\/(\d+)\/approve$/);
    if (m && args.includes("POST")) { const r = approve(m[1]!); return { code: r.code, stdout: "", stderr: r.stderr ?? "" }; }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { call, calls, approved: () => calls.filter((a) => a.includes("POST")).map((a) => a.find((x) => x.endsWith("/approve"))) };
}

describe("held runs on a contributor's pull request", () => {
  test("reads the runs held on the pull request's head", async () => {
    const g = fakeGh();
    const r = await readHeldRuns(g.call, "acme/orbit", 322);
    expect(r).toMatchObject({ ok: true, headSha: SHA, runs: [{ id: 9101, name: "build" }, { id: 9102, name: "catalogue" }] });
  });

  test("approves each held run, and only those", async () => {
    const g = fakeGh();
    const r = await approveHeldRuns(g.call, "acme/orbit", 322, SHA);
    expect(r).toEqual({ ok: true, approved: 2, detail: "Approved 2 workflows to run" });
    expect(g.approved()).toEqual(["repos/acme/orbit/actions/runs/9101/approve", "repos/acme/orbit/actions/runs/9102/approve"]);
  });

  test("not a maintainer: GitHub's 403 in plain words, nothing approved", async () => {
    const g = fakeGh(() => ({ code: 1, stderr: "gh: Must have admin rights to Repository. (HTTP 403)" }));
    const r = await approveHeldRuns(g.call, "acme/orbit", 322, SHA);
    expect(r).toEqual({ ok: false, approved: 0, error: "GitHub refused: only a maintainer of this repository can approve these workflows." });
  });

  test("one already approved: the other still goes, and the answer says both", async () => {
    const g = fakeGh((id) => id === "9102" ? { code: 1, stderr: "gh: This run is not waiting for approval (HTTP 422)" } : { code: 0 });
    const r = await approveHeldRuns(g.call, "acme/orbit", 322, SHA);
    expect(r).toEqual({ ok: false, approved: 1, error: "Approved 1 of 2. Already approved: nothing is waiting for approval any more." });
  });

  test("nothing held: says so and sends no approve", async () => {
    const g = fakeGh();
    const call: GhCall = async (args) => args.some((a) => a.includes("actions/runs?")) ? { code: 0, stdout: "[]", stderr: "" } : g.call(args);
    const r = await approveHeldRuns(call, "acme/orbit", 322, SHA);
    expect(r).toEqual({ ok: false, approved: 0, error: "Nothing is waiting for approval on this pull request." });
    expect(g.approved()).toEqual([]);
  });

  test("STALE: a push after the look is refused with both heads, and nothing is approved", async () => {
    const g = fakeGh();
    const r = await approveHeldRuns(g.call, "acme/orbit", 322, "b".repeat(40));
    expect(r).toEqual({ ok: false, approved: 0, error: "The pull request changed since you looked: bbbbbbb -> aaaaaaa. Look again." });
    expect(g.approved()).toEqual([]);
  });

  test("the short head the panel showed is enough when it matches", async () => {
    const g = fakeGh();
    expect((await approveHeldRuns(g.call, "acme/orbit", 322, SHA.slice(0, 12))).approved).toBe(2);
  });

  test("no head from the panel: refused before GitHub is asked", async () => {
    const g = fakeGh();
    for (const sha of [undefined, "", "not-a-sha"]) expect((await approveHeldRuns(g.call, "acme/orbit", 322, sha)).ok).toBe(false);
    expect(g.calls).toEqual([]);
  });

  test("an invalid number asks GitHub nothing", async () => {
    const g = fakeGh();
    expect((await readHeldRuns(g.call, "acme/orbit", 0)).ok).toBe(false);
    expect(g.calls).toEqual([]);
  });
});
