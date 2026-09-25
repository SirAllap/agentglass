/*
 * The environment a plugin install hands to git.
 *
 * The clone goes where the plugin's URL says, so it gets only what it needs:
 * the env is built by hand (no GIT_CONFIG_* pairs, agent sockets or host
 * tokens from the server's environment), and the two config keys a user's own
 * gitconfig could still set are cleared on the command line.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { pluginGitEnv, PLUGIN_GIT_CONFIG } from "../src/plugins.ts";

const PLUGINS = await Bun.file(new URL("../src/plugins.ts", import.meta.url)).text();

const LEAKS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "AGENTGLASS_TOKEN", "ORBIT_SECRET"];
const before: Record<string, string | undefined> = {};
for (const k of LEAKS) { before[k] = process.env[k]; process.env[k] = "orbit-value"; }
afterAll(() => { for (const k of LEAKS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });

describe("pluginGitEnv", () => {
  test("nothing the server carries reaches a plugin's git", () => {
    const env = pluginGitEnv();
    for (const k of LEAKS) expect(env[k]).toBeUndefined();
  });

  test("only names git needs are there, and none of them is a credential", () => {
    const allowed = new Set(["PATH", "HOME", "LANG", "GIT_TERMINAL_PROMPT", "GIT_LFS_SKIP_SMUDGE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "USERPROFILE", "TEMP", "TMP"]);
    for (const k of Object.keys(pluginGitEnv())) expect(allowed.has(k)).toBe(true);
  });

  test("the user's own gitconfig is not read, and ssh never prompts", () => {
    const env = pluginGitEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  test("a proxy the machine needs is kept", () => {
    const was = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.example.test:3128";
    try { expect(pluginGitEnv().HTTPS_PROXY).toBe("http://proxy.example.test:3128"); }
    finally { if (was === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = was; }
  });

  test("a header scoped to one URL in the user's gitconfig never reaches the host", async () => {
    // What a -c reset cannot clear: measured against a real git and a listener.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "agx-gitenv-"));
    let seen = "";
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen += req.headers.get("x-orbit-leak") ?? ""; return new Response("no", { status: 404 }); } });
    try {
      writeFileSync(join(home, ".gitconfig"), `[http "http://127.0.0.1:${srv.port}/"]\n\textraheader = X-Orbit-Leak: leaked\n`);
      const env = { ...pluginGitEnv(), HOME: home };
      const p = Bun.spawn(["git", ...PLUGIN_GIT_CONFIG, "ls-remote", `http://127.0.0.1:${srv.port}/acme/orbit.git`], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await p.exited;
      expect(seen).toBe("");
      const control = Bun.spawn(["git", "ls-remote", `http://127.0.0.1:${srv.port}/acme/orbit.git`], { env: { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0" }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await control.exited;
      expect(seen).toBe("leaked");
    } finally { srv.stop(true); rmSync(home, { recursive: true, force: true }); }
  });

  test("a prompt and LFS stay off", () => {
    const env = pluginGitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
  });

  test("the user's own credential helper and extra header are cleared on the command line", () => {
    expect(PLUGIN_GIT_CONFIG).toContain("credential.helper=");
    expect(PLUGIN_GIT_CONFIG).toContain("http.extraheader=");
  });

  test("every git the module spawns goes through pluginGitEnv and the cleared config", () => {
    expect(PLUGINS).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
    const i = PLUGINS.indexOf("async function git(");
    const body = PLUGINS.slice(i, PLUGINS.indexOf("\n}\n", i));
    expect(body).toContain("...PLUGIN_GIT_CONFIG");
    expect(body).toContain("env: pluginGitEnv()");
  });

  test("the HEAD lookup carries the cleared config too", () => {
    expect(PLUGINS).toContain('["git", ...PLUGIN_GIT_CONFIG, "rev-parse", "HEAD"]');
  });
});
