/* GET /polaris/github and the write error map, against a stub gh. The stub is first on PATH of a
   child process, because Bun.which reads the PATH the process started with (AGENTS.md). */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubError } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-gh-"));
const repo = join(dir, "orbit");
mkdirSync(repo);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
git("init", "-q"); git("remote", "add", "origin", "git@github.com:acme/orbit.git");
const noRemote = join(dir, "bare"); mkdirSync(noRemote); Bun.spawnSync(["git", "-C", noRemote, "init", "-q"]);

function shim(name: string, body: string): string {
  const bin = join(dir, name); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, "gh"), 0o755);
  return bin;
}
const SIGNED_IN = `case "$1" in auth) echo "github.com"; echo "  ✓ Logged in to github.com account ada-orbit (keyring)"; echo "  - Token scopes: 'repo', 'workflow'";; esac`;
const SIGNED_OUT = `echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1`;
const READ_ONLY = `case "$1" in auth) echo "  ✓ Logged in to github.com account ada-orbit"; echo "  - Token scopes: 'read:org'";; esac`;
const FAILS_403 = `case "$1" in run) echo "HTTP 403: Resource not accessible by integration" >&2; exit 1;; esac`;

/** The process env without what other test files set for the server (a broker socket, a port file): the child talks to the stub alone. */
const cleanEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTGLASS|AGX)_/.test(k))) as Record<string, string>;

/** Runs one script in a child that starts with the stub first on PATH. */
function child(bin: string, code: string): unknown {
  const p = Bun.spawnSync([process.execPath, "-e", `import * as P from ${JSON.stringify(join(import.meta.dir, "../src/polaris.ts"))};\n${code}`], {
    env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", XDG_CONFIG_HOME: join(dir, "cfg") },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString().trim().split("\n").pop()!);
}
const status = (bin: string, root: string) => child(bin, `console.log(JSON.stringify(await P.githubStatus(${JSON.stringify(root)})))`) as Record<string, unknown>;

describe("githubStatus", () => {
  test("signed in: repo, login and scope names; no token", () => {
    const s = status(shim("in", SIGNED_IN), repo);
    expect(s).toEqual({ ok: true, auth: "ok", repo: "acme/orbit", login: "ada-orbit", scopes: ["repo", "workflow"], canRerun: true, canUpdateBranch: true });
  });
  test("signed out says what to run", () => {
    const s = status(shim("out", SIGNED_OUT), repo);
    expect(s).toMatchObject({ ok: false, auth: "signed-out", repo: "acme/orbit", canRerun: false });
    expect(String(s.problem)).toContain("gh auth login");
  });
  test("a network error is not reported as signed out", () => {
    const s = status(shim("net", `echo "error connecting to api.github.com" >&2; exit 1`), repo);
    expect(String(s.problem)).not.toContain("gh auth login");
    expect(String(s.problem)).toContain("try again");
  });
  test("gh missing", () => {
    const empty = join(dir, "empty"); mkdirSync(empty);
    const p = Bun.spawnSync([process.execPath, "-e", `import * as P from ${JSON.stringify(join(import.meta.dir, "../src/polaris.ts"))};\nconsole.log(JSON.stringify(await P.githubStatus(${JSON.stringify(repo)}, async () => ({ code: 127, stdout: "", stderr: "gh not found" }))))`], { env: { ...cleanEnv(), XDG_CONFIG_HOME: join(dir, "cfg") } });
    expect(JSON.parse(p.stdout.toString().trim())).toMatchObject({ ok: false, auth: "no-gh" });
  });
  test("no remote", () => {
    expect(status(shim("in2", SIGNED_IN), noRemote)).toMatchObject({ ok: false, problem: "no GitHub remote on this repository" });
  });
  test("a token without repo or workflow cannot write", () => {
    expect(status(shim("ro", READ_ONLY), repo)).toMatchObject({ ok: true, scopes: ["read:org"], canRerun: false, canUpdateBranch: false });
  });
  test("a rerun refused with 403 is told in plain words", () => {
    const r = child(shim("f403", FAILS_403), `console.log(JSON.stringify(await P.rerunJob(${JSON.stringify(repo)}, 11)))`) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("lacks the repo or workflow scope");
  });
});

describe("githubError", () => {
  const e = (what: "rerun" | "update-branch", s: number) => githubError(what, { code: 1, stdout: "", stderr: `HTTP ${s}: x` });
  test("403, 404, 409 and 422 differ per action", () => {
    for (const s of [403, 404, 409, 422]) { expect(e("rerun", s)).not.toBe(e("update-branch", s)); expect(e("rerun", s)).toMatch(/^GitHub /); }
  });
  test("gh missing and signed out come first; an unknown status keeps gh's text", () => {
    expect(githubError("rerun", { code: 127, stdout: "", stderr: "gh not found" })).toContain("not installed");
    expect(githubError("update-branch", { code: 1, stdout: "", stderr: "To log in, run: gh auth login" })).toContain("signed out");
    expect(e("rerun", 500)).toBe("HTTP 500: x");
  });
});

describe("GET /polaris/github", () => {
  test("a relative or missing root answers 400; the route is open to an agent", async () => {
    for (const who of [{ kind: "person" }, { kind: "phone" }, { kind: "agent", name: "orbit-builder" }] as const) {
      expect((await polarisRoute("GET", "/polaris/github", new URLSearchParams(), {}, who))!.status).toBe(400);
      expect((await polarisRoute("GET", "/polaris/github", new URLSearchParams({ root: "orbit" }), {}, who))!.status).toBe(400);
    }
  });
});
