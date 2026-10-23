/*
 * The pull requests of a card that has no custom id.
 *
 * A free ClickUp workspace has none, so the card-to-pull-request search had
 * nothing to search with and every card said "no pull requests". Its default id
 * is written into a branch as `CU-86abc123_…` and into a description as the
 * task's address, and either finds the pull request.
 *
 * The search is run against a stub `gh` in a child process (the PATH
 * `Bun.which` resolves is the one the process started with); every call it
 * gets is written to a file, so "how many searches" is counted.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionsTask } from "../src/clickup.ts";

describe("does this pull request name that task?", () => {
  it("reads the branch the integration cuts, and the task's address", () => {
    expect(mentionsTask("86abc123", { headRefName: "CU-86abc123_retry-on-429_ada" })).toBe(true);
    expect(mentionsTask("86abc123", { title: "CU-86abc123 Retry on 429" })).toBe(true);
    expect(mentionsTask("86abc123", { body: "Card: https://app.clickup.com/t/86abc123" })).toBe(true);
    expect(mentionsTask("86abc123", { body: "https://app.clickup.com/t/900100/86abc123." })).toBe(true);
  });

  it("is not fooled by a longer id, a bare id or a pull request number", () => {
    expect(mentionsTask("86abc123", { headRefName: "CU-86abc1234_x" })).toBe(false);
    expect(mentionsTask("86abc123", { headRefName: "CU-86abc12_x" })).toBe(false);
    expect(mentionsTask("86abc123", { body: "see 86abc123 and #86abc123" })).toBe(false);
    expect(mentionsTask("86abc123", { body: "https://app.clickup.com/t/86abc1239" })).toBe(false);
    expect(mentionsTask("", { headRefName: "CU-86abc123" })).toBe(false);
  });
});

const dir = mkdtempSync(join(tmpdir(), "agx-cu-prs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rows = [
  { number: 91, title: "Retry on 429", state: "OPEN", url: "https://github.com/acme/orbit/pull/91", body: "", headRefName: "CU-86abc123_retry_ada", author: { login: "ada" } },
  { number: 77, title: "Unrelated", state: "OPEN", url: "https://github.com/acme/orbit/pull/77", body: "mentions 86abc123 in passing", headRefName: "fix/other", author: { login: "bob" } },
];
writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
const stub = join(dir, "gh");
writeFileSync(stub, `#!/bin/sh
echo "$@" >> "$AGX_STUB_CALLS"
case "$1" in
  api) echo ada ;;
  pr) cat "$AGX_STUB_ROWS" ;;
esac
`);
chmodSync(stub, 0o755);

async function ask(card: string, task: string) {
  const calls = join(dir, `calls-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(calls, "");
  const script = `import { cardPullRequests } from ${JSON.stringify(new URL("../src/clickup.ts", import.meta.url).pathname)};
    console.log(JSON.stringify(await cardPullRequests(${JSON.stringify(card)}, undefined, ${JSON.stringify(dir)}, ${JSON.stringify(task)})));`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: {
      PATH: `${dir}:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db"), AGX_STUB_CALLS: calls, AGX_STUB_ROWS: join(dir, "rows.json"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const lines = readFileSync(calls, "utf8").split("\n").filter(Boolean);
  return { got: JSON.parse(out.trim().split("\n").pop()!), search: lines.filter((l) => l.startsWith("pr list")) };
}

describe("a card with no custom id", () => {
  it("is one search for its default id, and only the pull request that names it comes back", async () => {
    const { got, search } = await ask("", "86abc123");
    expect(search).toHaveLength(1);
    expect(search[0]).toContain("--search 86abc123");
    expect(got.ok).toBe(true);
    expect(got.prs.map((p: { number: number }) => p.number)).toEqual([91]);
  });

  it("with nothing to search for it is no search at all", async () => {
    const { got, search } = await ask("", "");
    expect(search).toHaveLength(0);
    expect(got).toEqual({ ok: true, prs: [] });
  });

  it("a card WITH a custom id searches its text AND its branch prefix", async () => {
    const { search } = await ask("ORBIT-1042", "86abc123");
    expect(search).toHaveLength(2);
    expect(search[0]).toContain("--search ORBIT-1042");
    expect(search[1]).toContain("--search head:ORBIT-1042");
  });
});

describe("a pull request that carries the card id only in its branch", () => {
  const d2 = mkdtempSync(join(tmpdir(), "agx-cu-prs-head-"));
  afterAll(() => rmSync(d2, { recursive: true, force: true }));
  // What GitHub did on a real card: the text search found two, `head:` found all three
  // (the third is a revert whose title is the card's name and whose body never says the id).
  const text = [
    { number: 20037, title: "Intake", state: "OPEN", url: "https://github.com/acme/orbit/pull/20037", body: "ORBIT-1042", headRefName: "ORBIT-1042-intake", author: { login: "ada" } },
    { number: 19855, title: "Intake", state: "MERGED", url: "https://github.com/acme/orbit/pull/19855", body: "ORBIT-1042", headRefName: "ORBIT-1042-intake", author: { login: "ada" } },
  ];
  const head = [...text, { number: 20033, title: "Revert intake", state: "MERGED", url: "https://github.com/acme/orbit/pull/20033", body: "", headRefName: "ORBIT-1042-revert-intake", author: { login: "ada" } }];
  writeFileSync(join(d2, "text.json"), JSON.stringify(text));
  writeFileSync(join(d2, "head.json"), JSON.stringify(head));
  writeFileSync(join(d2, "gh"), `#!/bin/sh
case "$1" in
  api) echo ada ;;
  pr) case "$*" in *head:*) cat "${d2}/head.json" ;; *) cat "${d2}/text.json" ;; esac ;;
esac
`);
  chmodSync(join(d2, "gh"), 0o755);
  async function run(failHead: boolean) {
    if (failHead) writeFileSync(join(d2, "gh"), `#!/bin/sh
case "$1" in
  api) echo ada ;;
  pr) case "$*" in *head:*) echo boom >&2; exit 1 ;; *) cat "${d2}/text.json" ;; esac ;;
esac
`);
    const script = `import { cardPullRequests } from ${JSON.stringify(new URL("../src/clickup.ts", import.meta.url).pathname)};
      console.log(JSON.stringify(await cardPullRequests("ORBIT-1042", undefined, ${JSON.stringify(d2)}, "")));`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: `${d2}:${process.env.PATH}`, HOME: d2, NODE_ENV: "test", XDG_CONFIG_HOME: d2, XDG_DATA_HOME: d2, XDG_CACHE_HOME: d2, AGENTGLASS_STATE_DIR: d2, AGENTGLASS_DB: join(d2, "t.db") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return JSON.parse(out.trim().split("\n").pop()!);
  }
  it("is found, once, alongside the ones the text search finds", async () => {
    const got = await run(false);
    expect(got.ok).toBe(true);
    expect(got.prs.map((p: { number: number }) => p.number)).toEqual([20037, 20033, 19855]);
  });
  it("a failed branch search still returns what the text search found", async () => {
    const got = await run(true);
    expect(got.ok).toBe(true);
    expect(got.prs.map((p: { number: number }) => p.number)).toEqual([20037, 19855]);
  });
});
