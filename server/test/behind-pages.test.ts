/*
 * "What main brings" is the five NEWEST commits the base has and the branch
 * lacks. A comparison lists oldest first, 100 to a page, so when the branch is
 * more than 100 behind the newest are on the last page, not the first.
 * The stub `gh` serves commit number N as sha "cN" and counts `behind_by` from
 * a file the child rewrites between reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-behind-pages-"));
const bin = join(dir, "bin");
const repo = join(dir, "orbit");
const behindFile = join(dir, "behind");
let out: Record<string, { sha: string; title: string }[]> = {};
let failure = "";

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "auth status") echo "Logged in to github.com account octo-dev (keyring)"; exit 0;;',
    '  "auth token") echo "stub-token"; exit 0;;',
    "esac",
    'case "$*" in',
    '  *"pr view"*) echo \'{"baseRefName":"main","headRefName":"feat/thing"}\';;',
    '  *"/compare/"*"per_page=1"|*"/compare/"*"per_page=1 "*) echo "{\\"behind_by\\":$(cat ' + behindFile + '),\\"ahead_by\\":1}";;',
    // Page P of 100 holds commits (P-1)*100+1 .. min(P*100, behind), oldest first.
    '  *"/compare/"*)',
    '    p=$(echo "$*" | sed -n "s/.*page=\\([0-9]*\\).*/\\1/p"); b=$(cat ' + behindFile + ')',
    '    from=$(( (p-1)*100+1 )); to=$(( p*100 )); [ $to -gt $b ] && to=$b',
    '    printf \'{"commits":[\'; i=$from; while [ $i -le $to ]; do [ $i -gt $from ] && printf ,; printf \'{"sha":"c%s000","commit":{"message":"commit %s"}}\' $i $i; i=$((i+1)); done; printf \']}\';;',
    '  *"/pulls/5"*) echo \'{"head":{"sha":"abc123","repo":{"full_name":"acme/orbit"}},"base":{"sha":"def456"}}\';;',
    "  *) echo '[]';;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/acme/orbit.git");
  const home = join(dir, "home");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    NODE_ENV: "test",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AGENTGLASS_STATE_DIR: join(dir, "state"),
    AGENTGLASS_DB: join(dir, "agentglass.db"),
    AGENTGLASS_CACHE_DIR: join(dir, "cache"),
    TMUX_TMPDIR: join(dir, "tmux"),
  };
  delete env.TMUX;
  const child = Bun.spawn(["bun", new URL("./fixtures/behind-pages-child.ts", import.meta.url).pathname, repo, behindFile], { env, stdout: "pipe", stderr: "pipe" });
  const [so, se, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  try { out = JSON.parse(so.trim().split("\n").pop() ?? ""); } catch { failure = `exit ${code}: ${se.slice(-2000)} ${so.slice(-500)}`; }
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("what main brings, when main is far ahead", () => {
  it("ran against the stub", () => expect(failure).toBe(""));
  it("250 behind: the five newest, newest first, not the first page's tail", () => {
    expect(out.far?.map((c) => c.title)).toEqual(["commit 250", "commit 249", "commit 248", "commit 247", "commit 246"]);
  });
  it("102 behind: the last page holds two, the page before tops it up to five", () => {
    expect(out.topUp?.map((c) => c.title)).toEqual(["commit 102", "commit 101", "commit 100", "commit 99", "commit 98"]);
  });
});
