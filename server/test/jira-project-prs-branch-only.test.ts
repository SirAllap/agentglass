/*
 * The board reads every card's pull requests from ONE project search. GitHub's
 * search does not look at branch names, so a pull request whose title and body
 * never say the card key (only its branch does) was missing from the board.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-project-prs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const row = (number: number, headRefName: string, title: string, body = "", state = "MERGED") =>
  ({ number, state, reviewDecision: "APPROVED", url: `https://github.com/acme/orbit/pull/${number}`, author: { login: "ada" }, headRefName, title, body });
// The search finds the pull request that says the key in its title; the plain
// listing also holds the one that says it only in its branch.
writeFileSync(join(dir, "search.json"), JSON.stringify([row(201, "ORBIT-1041-add-thing", "ORBIT-1041 Add thing")]));
writeFileSync(join(dir, "recent.json"), JSON.stringify([
  row(201, "ORBIT-1041-add-thing", "ORBIT-1041 Add thing"),
  row(202, "ORBIT-1042-make-reverse-work", "Make reverse work", "", "OPEN"),
  row(203, "ORBIT-1043-more", "More", "", "OPEN"),
]));
const stub = join(dir, "gh");
writeFileSync(stub, `#!/bin/sh
case "$1" in
  api) case "$*" in *graphql*) echo call >> "${dir}/graphql.log"; echo "$*" | tr -d "\\n" >> "${dir}/graphql-q.log"; echo '{"data":{"repository":{"p202":{"mergeable":"CONFLICTING","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"checkRunCountsByState":[{"state":"SUCCESS","count":2},{"state":"FAILURE","count":1}],"statusContextCountsByState":[]}}}}]}},"p203":{"commits":{"nodes":[]}}}}}' ;; *) echo ada ;; esac ;;
  repo) echo '{}' ;;
  pr) case "$*" in *--search*) cat "${dir}/search.json" ;; *) cat "${dir}/recent.json" ;; esac ;;
esac
`);
chmodSync(stub, 0o755);
Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/acme/orbit.git"], { cwd: dir });

describe("projectPullRequests", () => {
  it("finds a pull request that names its card only in the branch", async () => {
    const script = `import { projectPullRequests } from ${JSON.stringify(new URL("../src/clickup.ts", import.meta.url).pathname)};
      console.log(JSON.stringify(await projectPullRequests("ORBIT", ${JSON.stringify(dir)})));`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (!out.trim()) throw new Error(err);
    const got = JSON.parse(out.trim().split("\n").pop()!);
    expect(Object.keys(got.byCard).sort()).toEqual(["ORBIT-1041", "ORBIT-1042", "ORBIT-1043"]);
    expect(got.byCard["ORBIT-1042"].map((p: { number: number }) => p.number)).toEqual([202]);
    expect(got.byCard["ORBIT-1041"]).toHaveLength(1);
  });

  it("reads the checks of every open pull request in ONE batched request and the review decision with the list", async () => {
    rmSync(join(dir, "graphql.log"), { force: true });
    rmSync(join(dir, "graphql-q.log"), { force: true });
    const script = `import { projectPullRequests } from ${JSON.stringify(new URL("../src/clickup.ts", import.meta.url).pathname)};
      console.log(JSON.stringify(await projectPullRequests("ORBIT", ${JSON.stringify(dir)})));`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db") },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const got = JSON.parse(out.trim().split("\n").pop()!);
    const open = got.byCard["ORBIT-1042"][0];
    expect(open.reviewDecision).toBe("APPROVED");
    expect(open.mergeable).toBe("CONFLICTING");
    expect(open.checks).toMatchObject({ success: 2, failure: 1, verdict: "red" });
    expect(got.byCard["ORBIT-1041"][0].checks).toBeUndefined();
    const calls = readFileSync(join(dir, "graphql.log"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    const q = readFileSync(join(dir, "graphql-q.log"), "utf8");
    expect(q).toContain("p202");
    expect(q).toContain("mergeable");
    expect(q).toContain("p203");
    expect(q).not.toContain("p201");
  });
});
