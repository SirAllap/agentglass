/*
 * A pull request of a repository with no checkout (`gh:owner/name`) said "Ready
 * to merge" with the Merge button greyed, though GitHub lets the person merge
 * it. Every write was refused for want of a directory, and most of them never
 * needed one: they are `gh ... -R owner/name` or `gh api`. These run the real
 * functions in a child process whose PATH has a `gh` that only writes down its
 * argv (the server resolves `gh` once at start, so a stub has to be there before
 * it starts), and nothing here can reach a real pull request.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "gh:acme/orbit";
// Each case: the call, then what the stub must have been asked (substring of the one line it logged).
const WRITES: [string, string, string][] = [
  ["merge", `P.mergePr(R, 7, "squash", { deleteBranch: true })`, "pr merge 7 --squash --delete-branch -R acme/orbit"],
  ["merge when green", `P.mergePr(R, 7, "merge", { auto: true })`, "pr merge 7 --merge --auto -R acme/orbit"],
  ["cancel auto-merge", `P.mergePr(R, 7, "merge", { disableAuto: true })`, "pr merge 7 --disable-auto -R acme/orbit"],
  ["close", `P.closePr(R, 7)`, "pr close 7 -R acme/orbit"],
  ["reopen", `P.closePr(R, 7, true)`, "pr reopen 7 -R acme/orbit"],
  ["to draft", `P.setDraft(R, 7, true)`, "pr ready 7 --undo -R acme/orbit"],
  ["to ready", `P.setDraft(R, 7, false)`, "pr ready 7 -R acme/orbit"],
  ["labels", `P.setLabels(R, 7, ["bug"], ["wip"])`, "pr edit 7 --add-label bug --remove-label wip -R acme/orbit"],
  ["assignees", `P.setAssignees(R, 7, ["octo"], [])`, "pr edit 7 --add-assignee octo -R acme/orbit"],
  ["reviewers", `P.setReviewers(R, 7, ["octo"], [])`, "pr edit 7 --add-reviewer octo -R acme/orbit"],
  ["milestone", `P.setMilestone(R, 7, "v1")`, "pr edit 7 --milestone v1 -R acme/orbit"],
  ["title", `P.editPr(R, 7, { title: "Fix thing" })`, "pr edit 7 --title Fix thing -R acme/orbit"],
  ["comment", `P.addComment(R, 7, "looks good")`, "pr comment 7 --body-file - -R acme/orbit"],
  ["approve", `P.submitReview(R, 7, "approve", "")`, "pr review 7 --approve -R acme/orbit"],
  ["resolve thread", `P.setThreadResolved(R, "PRRT_abc", true)`, "api graphql"],
  ["react", `P.react(R, "IC_abc", "THUMBS_UP")`, "api graphql"],
  ["edit comment", `P.editComment(R, "IC_abc", "new text")`, "api graphql"],
  ["update branch", `P.updateBranch(R, 7)`, "pr update-branch 7 -R acme/orbit"],
  ["reply to a thread", `P.replyToThread(R, 7, 123, "thanks")`, "repos/acme/orbit/pulls/7/comments"],
  ["delete comment", `P.deleteComment(R, "IC_abc")`, "api graphql"],
  ["hide comment", `P.hideComment(R, "IC_abc")`, "api graphql"],
  ["unhide comment", `P.unhideComment(R, "IC_abc")`, "api graphql"],
  ["mark file viewed", `P.setFileViewed(R, "PR_abc", "a.ts", true)`, "api graphql"],
  ["re-run all jobs of a run", `P.rerunJobs(R, "all", "55")`, "repos/acme/orbit/actions/runs/55/rerun"],
  ["re-run failed jobs of a run", `P.rerunJobs(R, "failed", "55")`, "repos/acme/orbit/actions/runs/55/rerun-failed-jobs"],
  ["re-run one job", `P.rerunJobs(R, "job", "123")`, "api --method POST repos/acme/orbit/actions/jobs/123/rerun"],
];
// Each of these works in a working tree of the repository, and a `gh:` root has none.
const NEEDS_CHECKOUT: [string, string][] = [
  ["apply suggestion", `P.applySuggestion(R, 7, { path: "a.ts", line: 1, suggestion: "x" })`],
  ["unstick close", `P.unstickClose(R, 7)`],
  ["unstick reopen", `P.unstickReopen(R, 7)`],
];

// These read from GitHub first (the stub answers "ok", which is no pull request), so they stop short of
// the write: what is asserted is that they reached gh at all and were not turned away for want of a checkout.
const REACHES_GH: [string, string][] = [
  ["review with line comments", `P.submitReviewWith(R, 7, "comment", "x", [{ path: "a.ts", line: 1, body: "y" }])`],
  ["line comment", `P.addLineComment(R, 7, { path: "a.ts", line: 1, side: "RIGHT", body: "y" })`],
  ["re-run failed checks", `P.rerunFailedChecks(R, 7)`],
];

let dir: string;
let out: Record<string, { res: any; argv: string[] }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-foreign-writes-"));
  const log = join(dir, "gh.log");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\necho "$*" >> "${log}"\necho ok\n`);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  const cases = [...WRITES.map(([n, c]) => [n, c]), ...REACHES_GH, ...NEEDS_CHECKOUT];
  const script = `
    import * as P from ${JSON.stringify(new URL("../src/prs.ts", import.meta.url).pathname)};
    import { readFileSync, writeFileSync, existsSync } from "node:fs";
    const R = ${JSON.stringify(ROOT)}, log = ${JSON.stringify(log)};
    const cases = [${cases.map(([n, c]) => `[${JSON.stringify(n)}, () => ${c}]`).join(",")}];
    const out = {};
    for (const [name, run] of cases) {
      writeFileSync(log, "");
      const res = await run();
      out[name] = { res, argv: readFileSync(log, "utf8").split("\\n").filter(Boolean) };
    }
    console.log("RESULT " + JSON.stringify(out));
  `;
  const p = Bun.spawn(["bun", "-e", script], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, NODE_ENV: "test", HOME: dir,
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "a.db"), TMUX_TMPDIR: dir,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const line = so.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`child gave no result:\n${so}\n${se}`);
  out = JSON.parse(line.slice(7));
}, 30_000);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

for (const [name, , want] of WRITES) {
  test(`${name}: made on a checkout-less root, through gh with the repository named`, () => {
    const r = out[name]!;
    expect(r.res.ok).toBe(true);
    expect(r.argv.length).toBeGreaterThan(0);
    expect(r.argv.some((l) => l.includes(want))).toBe(true);
  });
}

for (const [name] of NEEDS_CHECKOUT) {
  test(`${name}: still refused on a checkout-less root, in a sentence, with gh never called`, () => {
    const r = out[name]!;
    expect(r.res.ok).toBe(false);
    expect(r.res.error).toMatch(/no checkout/i);
    expect(r.argv).toEqual([]);
  });
}

for (const [name] of REACHES_GH) {
  test(`${name}: not turned away for want of a checkout, gh is reached`, () => {
    const r = out[name]!;
    expect(String(r.res.error ?? "")).not.toMatch(/no checkout|read-only/i);
    expect(r.argv.length).toBeGreaterThan(0);
  });
}
