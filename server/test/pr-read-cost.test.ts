/*
 * What the pull request panel's repeated reads cost in `gh` spawns, counted.
 *
 * Each row below was measured against a stub `gh` on an isolated server before
 * it was fixed, and every one returned the same body the time before:
 *
 *   detail opened cold, then re-asked 1.2 s later with force  4 spawns for 1 read
 *   pending review, behind-count, checks rollup              1 spawn per call
 *   "expand context" on the same file                        2 spawns per click
 *   facets asked by two callers at once                      double
 *   inbox polled every 60 s against a 45 s TTL               a spawn per poll
 *
 * The reads run in a child with the stub first on its PATH (`Bun.which` only
 * sees the PATH the process started with); see fixtures/pr-read-cost-child.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-read-cost-"));
const bin = join(dir, "bin");
const repo = join(dir, "orbit");
const log = join(dir, "gh.log");
let out: Record<string, number> = {};
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
    // A real call takes time; two callers in the same tick overlap.
    "sleep 0.05",
    // One line per call, however many lines the query has.
    `printf '%s\\n' "$(echo "$*" | tr '\\n' ' ')" >> "${log}"`,
    'case "$*" in',
    '  *"pr diff"*) printf \'diff --git a/x b/x\\n--- a/x\\n+++ b/x\\n@@ -1 +1 @@\\n-a\\n+b\\n\';;',
    '  *"pr view"*) echo \'{"baseRefName":"main","headRefName":"feat/thing"}\';;',
    '  *"reviews(states"*) echo \'{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]}}}}}\';;',
    '  *"reviewThreads"*) echo \'{"data":{"repository":{"pullRequest":{"number":5,"title":"t","state":"OPEN","baseRefName":"main","headRefName":"feat/thing","author":{"login":"octo-dev"}}}}}\';;',
    '  *"contexts(first:100)"*) echo \'{"data":{"repository":{"pullRequest":{"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[]}}}}]}}}}}\';;',
    '  *"api graphql"*) echo \'{"data":{"repository":{"pullRequest":{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}}}}\';;',
    '  *"/compare/"*) echo \'{"behind_by":3,"ahead_by":1}\';;',
    '  *"/pulls/5"*) echo \'{"head":{"sha":"abc123","repo":{"full_name":"acme/orbit"}},"base":{"sha":"def456"}}\';;',
    '  *"/contents/"*) echo \'{"content":"b25lCnR3bwo=","encoding":"base64"}\';;',
    // A conditional read of the inbox answers 304 the way `gh api -i` does.
    "  *'If-None-Match: W/\"abc\"'*) printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: W/\"abc\"\\r\\n\\r\\n'; echo 'gh: HTTP 304' >&2; exit 1;;",
    '  *"/notifications"*) printf \'HTTP/2.0 200 OK\\r\\nEtag: W/"abc"\\r\\n\\r\\n[]\';;',
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
  const child = Bun.spawn(["bun", new URL("./fixtures/pr-read-cost-child.ts", import.meta.url).pathname, repo, log], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [so, se, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  try { out = JSON.parse(so.trim().split("\n").pop() ?? ""); } catch { failure = `exit ${code}: ${se.slice(-2000)} ${so.slice(-500)}`; }
}, 60_000);

afterAll(() => { if (process.env.KEEP_LOG) console.log(readFileSync(log, "utf8")); rmSync(dir, { recursive: true, force: true }); });

describe("what the panel's repeated reads cost", () => {
  it("ran against the stub", () => {
    if (process.env.KEEP_LOG) console.log(JSON.stringify(out));
    expect(failure).toBe("");
    expect(existsSync(log) ? readFileSync(log, "utf8").length : 0).toBeGreaterThan(0);
  });

  it("a detail asked twice at once is one read (two graphql calls, not four)", () => {
    expect(out.detailColdTwice).toBe(2);
    // The stale follow-up: the same, forced, joins a running read.
    expect(out.detailForcedTwice).toBe(2);
    expect(out.detailReopen).toBe(0);
  });

  it("the pending review, the behind count and the checks rollup are asked once", () => {
    expect(out.pendingReviewX3).toBe(1);
    expect(out.behindX3).toBe(1);
    expect(out.rollupX3).toBe(1);
  });

  it("an explicit refresh of the behind count still asks GitHub", () => {
    expect(out.behindFresh).toBe(1);
  });

  it("the same file at the same commit is fetched once however often it is expanded", () => {
    // pulls/N once, contents once.
    expect(out.fileSliceX3).toBe(2);
  });

  it("the diff is one spawn however often the Diff view is opened again", () => {
    expect(out.diffOpenedThrice).toBe(1);
  });

  it("two callers of the facets share one set of reads", () => {
    expect(out.facetsTwiceAtOnce).toBe(5);
  });

  it("the inbox does not spawn inside its window, and asks conditionally after it", () => {
    expect(out.inboxFirst).toBe(1);
    expect(out.inboxAt50s).toBe(0);
    // Past the window it does spawn (free of quota: it is a 304), once.
    expect(out.inboxAt110s).toBe(1);
  });
});
