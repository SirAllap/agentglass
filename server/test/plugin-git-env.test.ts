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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGINS = await Bun.file(new URL("../src/plugins.ts", import.meta.url)).text();
const SOURCES = await Bun.file(new URL("../src/plugin-sources.ts", import.meta.url)).text();

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
  test("the ls-files behind the content hash gets the scrubbed env, not the server's", async () => {
    // A stub git on the child's PATH writes the environment it was given.
    // Bun.which resolves against the PATH the process started with, so the
    // stub has to be there before the child starts.
    const root = mkdtempSync(join(tmpdir(), "agx-lsfiles-"));
    try {
      const bin = join(root, "bin");
      const plugin = join(root, "orbit-plugin");
      mkdirSync(bin);
      mkdirSync(join(plugin, ".git"), { recursive: true });
      writeFileSync(join(plugin, "run.sh"), "echo hi\n");
      writeFileSync(join(bin, "git"), `#!/bin/sh\nenv > "${join(root, "seen.txt")}"\n`);
      chmodSync(join(bin, "git"), 0o755);
      const src = new URL("../src/plugin-sources.ts", import.meta.url).pathname;
      const child = Bun.spawn(["bun", "-e", `import { contentHash } from ${JSON.stringify(src)}; contentHash(${JSON.stringify(plugin)}, ["run.sh"]);`], {
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, GH_TOKEN: "orbit-value", SSH_AUTH_SOCK: "/run/orbit.sock", ORBIT_SECRET: "orbit-value" },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const seen = readFileSync(join(root, "seen.txt"), "utf8");
      expect(seen).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      for (const k of ["GH_TOKEN", "SSH_AUTH_SOCK", "ORBIT_SECRET"]) expect(seen).not.toContain(`${k}=`);
      expect(err).not.toContain("error");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("indexExecutables builds no env of its own", () => {
    const i = SOURCES.indexOf("function indexExecutables(");
    const body = SOURCES.slice(i, SOURCES.indexOf("\n}\n", i)).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(body).toContain("env: pluginGitEnv()");
    expect(body).not.toContain("process.env");
  });
});
