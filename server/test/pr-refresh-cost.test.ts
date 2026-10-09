/*
 * What one press of Refresh, and the panel's first load, cost in GitHub
 * GraphQL requests — counted, not read off the source.
 *
 * Refresh forced the table and the board's two lists, each a rows request and
 * a checks request: measured at 39 points of the account's hourly 5000 for one
 * press. YOUR two queues are now one request between them (QUEUES_QUERY in
 * prs.ts, 3 points by `rateLimit(dryRun:true)`), so both are pinned here at
 * exactly one. The list code runs in a child with a stub `gh` first on its
 * PATH and a counted `fetch`; see fixtures/pr-refresh-cost-child.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-refresh-cost-"));
const bin = join(dir, "bin");
const repo = join(dir, "orbit");
const ghLog = join(dir, "gh.log");
let out: { first: string[]; refresh: string[]; firstRows: any; refreshRows: any } | null = null;
let failure = "";

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  // Only what the list path asks of gh: who is signed in, and the token. Any
  // other call is logged, and the test fails on it (a `gh api graphql` would be
  // a request the fetch counter cannot see).
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "auth status") echo "Logged in to github.com account octo-dev (keyring)"; exit 0;;',
    '  "auth token") echo "stub-token"; exit 0;;',
    "esac",
    `echo "$*" >> "${ghLog}"`,
    "exit 1",
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
  const child = Bun.spawn(["bun", new URL("./fixtures/pr-refresh-cost-child.ts", import.meta.url).pathname, repo], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [so, se, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = so.trim().split("\n").pop() ?? "";
  try { out = JSON.parse(line); } catch { failure = `exit ${code}: ${se.slice(-2000)} ${so.slice(-500)}`; }
}, 30_000);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("what a Refresh costs", () => {
  it("ran against the stub, not the network", () => {
    expect(failure).toBe("");
    expect(out).not.toBeNull();
    // Nothing reached gh beyond who is signed in and the token.
    expect(existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "").toBe("");
  });

  it("loads both queues on first open in ONE request", () => {
    expect(out!.first).toEqual(["queues"]);
    expect(out!.firstRows).toEqual({ mine: [1, 2], review: [3] });
  });

  it("answers one press of Refresh, table and board, with ONE request", () => {
    expect(out!.refresh).toEqual(["queues"]);
    expect(out!.refreshRows).toEqual({ mine: [1, 2], review: [3], checksLoaded: true, totals: [2, 1] });
  });
});
