// The lookup behind "Add a GitHub repo": a name with no checkout, asked of
// GitHub through `gh api` (REST only). `ghBin()` resolves against the PATH the
// process STARTED with, so every case that needs a `gh` runs in a child that
// was handed a PATH whose `gh` is ours. The fake logs its argv, which is how
// "a malformed name never spawns" is asserted rather than assumed.
import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookupError, validRepo } from "../src/repoLookup.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-repolookup-")));
const MOD = fileURLToPath(new URL("../src/repoLookup.ts", import.meta.url));
const SHIM = join(dir, "shim");
const LOG = join(dir, "argv.log");
const DRIVER = join(dir, "ask.mjs");
const PID = join(dir, "gh.pid");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(() => {
  mkdirSync(SHIM, { recursive: true });
  // AGX_SCENARIO picks the answer; the repo call and the count call differ.
  writeFileSync(join(SHIM, "gh"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$AGX_GH_LOG"',
    'case "$*" in',
    '  auth*) [ "$AGX_SCENARIO" = authhang ] && { echo $$ > "$AGX_PID"; exec sleep 3; }; echo "Logged in to github.com account dev-one (keyring)"; exit 0;;',
    '  *search/issues*) [ "$AGX_SCENARIO" = slow2 ] && sleep 0.2; [ "$AGX_SCENARIO" = nocount ] && { echo "HTTP 500" >&2; exit 1; }; echo \'{"total_count":14}\'; exit 0;;',
    "esac",
    'case "$AGX_SCENARIO" in',
    '  slow2) sleep 0.2; case "$*" in *search/issues*) echo \'{"total_count":1}\';; *) echo \'{"full_name":"Acme/Orbit-API","private":false,"default_branch":"main"}\';; esac;;',
    '  found|nocount) echo \'{"full_name":"Acme/Orbit-API","private":true,"description":"x","default_branch":"main"}\';;',
    '  404) echo "gh: Not Found (HTTP 404)" >&2; exit 1;;',
    '  ratelimit) echo "gh: API rate limit exceeded for user (HTTP 403)" >&2; exit 1;;',
    '  403|authhang) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1;;',
    '  401) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4;;',
    '  hang) echo $$ > "$AGX_PID"; exec sleep 3;;',
    '  *) echo "dial tcp: network is unreachable" >&2; exit 1;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(SHIM, "gh"), 0o755);
  writeFileSync(DRIVER, [
    "const [mod, repo, fresh] = process.argv.slice(2);",
    "const { repoLookup } = await import(mod);",
    "const { keptCount } = await import(mod);",
    'if (repo.includes(",")) { for (const r of repo.split(",")) await repoLookup(r, false); process.stdout.write("RESULT " + JSON.stringify([keptCount()]) + "\\n"); process.exit(0); }',
    "const a = await repoLookup(repo, false);",
    'const b = await repoLookup(repo, fresh === "1");',
    'process.stdout.write("RESULT " + JSON.stringify([a, b]) + "\\n");',
    "",
  ].join("\n"));
});

function ask(repo: string, scenario: string, fresh = false, extra: Record<string, string> = {}): any[] {
  writeFileSync(LOG, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(GH|GITHUB)_/.test(k)) env[k] = v;
  const r = Bun.spawnSync([process.execPath, DRIVER, MOD, repo, fresh ? "1" : "0"], {
    env: { ...env, PATH: `${SHIM}:/usr/bin:/bin`, AGX_SCENARIO: scenario, AGX_GH_LOG: LOG, AGX_PID: PID, AGX_REPO_LOOKUP_MS: "300", ...extra },
    stdout: "pipe", stderr: "pipe",
  });
  const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(r.stderr.toString() || r.stdout.toString());
  return JSON.parse(line.slice(7));
}
const calls = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean);

describe("validRepo", () => {
  test("accepts owner/name", () => {
    expect(validRepo("acme/orbit")).toBe(true);
    expect(validRepo("acme/orbit.js_2-x")).toBe(true);
  });
  test("refuses anything that is not exactly owner/name", () => {
    for (const bad of ["", "acme", "acme/", "/orbit", "a/b/c", "acme/..", "acme/.", "-acme/orbit", "acme/or bit", "acme/orbit;rm", "acme/orbit?x=1", "ac me/orbit", "acme/$(x)"]) expect(validRepo(bad)).toBe(false);
  });
});

describe("lookupError", () => {
  const r = (code: number, stderr: string) => ({ code, stdout: "", stderr });
  test("maps every failure to one sentence", () => {
    expect(lookupError(r(127, "gh not found"))).toBe("gh-missing");
    expect(lookupError(r(4, "run: gh auth login"))).toBe("gh-not-signed-in");
    expect(lookupError(r(1, "HTTP 401: Bad credentials"))).toBe("gh-not-signed-in");
    expect(lookupError(r(1, "Not Found (HTTP 404)"))).toBe("not-found");
    expect(lookupError(r(1, "forbidden (HTTP 403)"))).toBe("no-access");
    expect(lookupError(r(1, "Resource not accessible by integration"))).toBe("no-access");
    expect(lookupError(r(1, "SAML enforcement"))).toBe("no-access");
    // a spent budget answers 403 as well; it is "later", not "not yours"
    expect(lookupError(r(1, "gh: API rate limit exceeded (HTTP 403)"))).toBe("unreachable");
    expect(lookupError(r(1, "You have exceeded a secondary rate limit (HTTP 403)"))).toBe("unreachable");
    expect(lookupError(r(1, "network is unreachable"))).toBe("unreachable");
    expect(lookupError("timeout")).toBe("unreachable");
  });
});

describe("repoLookup with a fake gh", () => {
  test("found: canonical casing, privacy, open PR count; REST calls only", () => {
    const [a] = ask("acme/orbit-api", "found");
    expect(a).toEqual({ found: true, repo: "Acme/Orbit-API", private: true, description: "x", defaultBranch: "main", openPrs: 14 });
    const c = calls();
    expect(c[0]).toBe("api repos/acme/orbit-api");
    expect(c.some((l) => /graphql|repo view/.test(l))).toBe(false);
  });
  test("the count failing still finds the repository", () => {
    const [a] = ask("acme/orbit-api", "nocount");
    expect(a.found).toBe(true);
    expect("openPrs" in a).toBe(false);
  });
  test("a success is cached; fresh=1 and a failure are not", () => {
    ask("acme/orbit-api", "found");
    expect(calls().length).toBe(2); // repo + count once, the second ask came from the cache
    ask("acme/orbit-api", "found", true);
    expect(calls().length).toBe(4); // fresh=1 asks again
    ask("acme/orbit-api", "404");
    expect(calls()).toEqual(["api repos/acme/orbit-api", "api repos/acme/orbit-api"]); // a failure is asked both times
  });
  for (const [scenario, error] of [["404", "not-found"], ["403", "no-access"], ["401", "gh-not-signed-in"], ["net", "unreachable"]] as const) {
    test(`${scenario} -> ${error}`, () => {
      expect(ask("acme/orbit", scenario)[0]).toMatchObject({ found: false, error });
    });
  }
  test("the memory of answers has a ceiling", () => {
    const names = Array.from({ length: 8 }, (_, i) => `acme/r${i}`).join(",");
    expect(ask(names, "found", false, { AGX_REPO_KEEP_MAX: "3" })[0]).toBe(3);
  });
  test("the whole lookup shares one deadline: a slow count is dropped, the repo is still found", () => {
    // 300 ms budget, each call takes 200 ms: the count has 100 ms left and is killed
    const t0 = Date.now();
    const [a] = ask("acme/orbit-api", "slow2");
    expect(a.found).toBe(true);
    expect("openPrs" in a).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
  test("a 403 that names a rate limit is unreachable, not no-access", () => {
    expect(ask("acme/orbit", "ratelimit")[0]).toEqual({ found: false, error: "unreachable" });
  });
  test("a malformed name is refused before gh is spawned", () => {
    expect(ask("acme/orbit;ls", "found")[0]).toEqual({ found: false, error: "bad-repo" });
    expect(calls().length).toBe(0);
  });
  test("a gh that never answers is unreachable, and is killed rather than left running", () => {
    writeFileSync(PID, "");
    const t0 = Date.now();
    expect(ask("acme/orbit", "hang")[0]).toEqual({ found: false, error: "unreachable" });
    // 300 ms budget; the fake would sleep 3 s. Returning early is half of it,
    // the process being gone is the other half.
    expect(Date.now() - t0).toBeLessThan(2500);
    const pid = Number(readFileSync(PID, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });
  test("no-access names the signed-in account", () => {
    expect(ask("acme/orbit", "403", false, { AGX_REPO_LOOKUP_MS: "3000" })[0]).toEqual({ found: false, error: "no-access", account: "dev-one" });
  });
  test("a lost race for the account kills gh auth status", () => {
    writeFileSync(PID, "");
    const t0 = Date.now();
    const [a] = ask("acme/orbit", "authhang");
    expect(a).toEqual({ found: false, error: "no-access" });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(alive(Number(readFileSync(PID, "utf8").trim()))).toBe(false);
  });
});
