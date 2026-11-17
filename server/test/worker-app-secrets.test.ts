/*
 * A worker must not read the app's own credential files, and must not spend a
 * token through its browser. A verifier once read the machine token from the
 * config dir and opened `/?token=…`, logging itself in as the person.
 *
 * The fixture is a temp XDG_CONFIG_HOME; the real token file is never read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxFor } from "../src/agents/headless.ts";
import { appSecretDirs, compileEnvelope } from "../src/agents/envelope.ts";
import { agentAskRefusal, bodyCarriesToken, urlCarriesToken, WORKER_AUTH_HEADER_REFUSAL } from "../src/browserdrive.ts";
import { WORKER_ROLES } from "../../shared/workerRoles.ts";
import type { Envelope } from "../../shared/orchestration.ts";

const xdg = mkdtempSync(join(tmpdir(), "agx-secret-"));
const saved = process.env.XDG_CONFIG_HOME;
beforeAll(() => { process.env.XDG_CONFIG_HOME = xdg; });
afterAll(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
  rmSync(xdg, { recursive: true, force: true });
});

const dir = () => join(process.env.XDG_CONFIG_HOME!, "agentglass");
const closed: Envelope = { write: "worktree", commit: true, network: false, docker: false, deny: [] };
const open: Envelope = { ...closed, network: true, docker: true };

describe("the app's credential directory is shut to every role", () => {
  test("appSecretDirs follows XDG_CONFIG_HOME", () => {
    expect(appSecretDirs()).toContain(dir());
  });

  for (const role of WORKER_ROLES) {
    for (const [name, env] of [["closed", closed], ["open", open]] as const) {
      test(`${role.id} (${name}): Claude Read deny and sandbox denyRead`, () => {
        const c = compileEnvelope("claude", role, env, "", join(xdg, "locks"));
        expect(c.ok).toBe(true);
        if (!c.ok) return;
        const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
        expect(deny).toContain(`Read(/${dir()}/**)`);
        const box = sandboxFor(role, closed, xdg) as { filesystem: { denyRead?: string[] } } | null;
        expect(box?.filesystem.denyRead).toContain(dir());
      });
    }
    test(`${role.id}: Qwen file and OpenCode config`, () => {
      const q = compileEnvelope("qwen", role, closed, "", join(xdg, "locks"));
      if (q.ok) {
        const f = Object.values(q.env).find((v) => v.endsWith("-envelope.json"));
        expect(f).toBeTruthy();
        expect(require("node:fs").readFileSync(f!, "utf8")).toContain(`Read(/${dir()}/**)`);
      }
      const o = compileEnvelope("opencode", role, closed, "", join(xdg, "locks"));
      if (o.ok) {
        const cfg = JSON.parse(Object.values(o.env).find((v) => v.startsWith("{"))!);
        expect(cfg.permission.read[`${dir()}/**`]).toBe("deny");
        expect(cfg.agent.build.permission.read[`${dir()}/**`]).toBe("deny");
        expect(cfg.permission.bash[`*${dir()}*`]).toBe("deny");
      }
    });
  }
});

describe("the browser relay refuses a URL that carries a token", () => {
  test("token in the query or the hash", () => {
    expect(urlCarriesToken("http://127.0.0.1:4000/?token=abc")).toBe(true);
    expect(urlCarriesToken("http://127.0.0.1:4000/#/x?TOKEN=abc")).toBe(true);
    expect(urlCarriesToken("http://127.0.0.1:4000/?a=1&token=abc")).toBe(true);
    expect(urlCarriesToken("http://example.com/tokens?x=1")).toBe(false);
  });
  test("a scrape list is looked at entry by entry", () => {
    const bad = { op: "scrape", urls: ["http://example.com/", "http://127.0.0.1:4000/?token=abc"] };
    expect(agentAskRefusal(bad, "alba", "scrape")).toContain("token=");
    expect(agentAskRefusal({ op: "scrape", urls: ["http://example.com/"] }, "alba", "scrape") ?? "").not.toContain("token=");
  });
  test("a worker's open is refused, and the same open without token is not", () => {
    const bad = agentAskRefusal({ op: "open", url: "http://127.0.0.1:4000/?token=abc" }, "alba", "open");
    expect(bad).toContain("token=");
    expect(agentAskRefusal({ op: "open", url: "http://127.0.0.1:4000/" }, "alba", "open") ?? "").not.toContain("token=");
  });
});

const globRe = (g: string) => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const refusedLine = (globs: string[], line: string) => globs.some((g) => globRe(g).test(line));

describe("a shell line that names the credential dir is refused where the shell is not sandboxed", () => {
  const lines = [
    `cat ${"${DIR}"}/token`,
    "cat ~/.config/agentglass/token",
    "cat $HOME/.config/agentglass/token",
    "cat ${HOME}/.config/agentglass/token",
    "cat $XDG_CONFIG_HOME/agentglass/token",
    "cd ~/.config/agentglass && cat token",
    "cd ~/.config && cat agentglass/token",
  ];
  test("OpenCode bash deny covers each spelling", () => {
    const o = compileEnvelope("opencode", WORKER_ROLES[0]!, closed, "", join(xdg, "locks"));
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const cfg = JSON.parse(Object.values(o.env).find((v) => v.startsWith("{"))!);
    const globs = Object.entries(cfg.permission.bash).filter(([, v]) => v === "deny").map(([k]) => k);
    for (const l of lines) expect([l, refusedLine(globs, l.replace("${DIR}", dir()))]).toEqual([l, true]);
    expect(refusedLine(globs, "cat README.md")).toBe(false);
  });
  test("Claude with no sandbox (network lifted) denies the same lines; sandboxed leaves it to denyRead", () => {
    const role = WORKER_ROLES[0]!;
    const deny = (env: Envelope) => {
      const c = compileEnvelope("claude", role, env, "", join(xdg, "locks"));
      if (!c.ok) throw new Error(c.error);
      return (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    };
    const bash = deny(open).filter((r) => r.startsWith("Bash(*")).map((r) => r.slice(5, -1));
    for (const l of lines) expect([l, refusedLine(bash, l.replace("${DIR}", dir()))]).toEqual([l, true]);
    expect(deny(closed).some((r) => r.startsWith("Bash(*.config/agentglass"))).toBe(false);
  });
});

describe("a symlinked credential file is denied at its target too", () => {
  test("appSecretDirs follows the token link", () => {
    mkdirSync(dir(), { recursive: true });
    const elsewhere = join(xdg, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "real-token"), "x");
    symlinkSync(join(elsewhere, "real-token"), join(dir(), "token"));
    const real = require("node:fs").realpathSync(join(elsewhere, "real-token"));
    expect(appSecretDirs()).toContain(real);
    const c = compileEnvelope("claude", WORKER_ROLES[0]!, closed, "", join(xdg, "locks"));
    if (c.ok) expect((JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).toContain(`Read(/${real})`);
  });
});

describe("a worker cannot set an Authorization header", () => {
  test("refused whatever case, other headers are not its business here", () => {
    expect(agentAskRefusal({ op: "headers", headers: { authorization: "Bearer x" } }, "alba", "headers")).toBe(WORKER_AUTH_HEADER_REFUSAL);
    expect(agentAskRefusal({ op: "headers", headers: { Authorization: "Bearer x" } }, "alba", "headers")).toBe(WORKER_AUTH_HEADER_REFUSAL);
    expect(agentAskRefusal({ op: "headers", headers: { "X-Test": "1" } }, "alba", "headers")).not.toBe(WORKER_AUTH_HEADER_REFUSAL);
  });
});

describe("a token hides in no string of the body", () => {
  const T = "http://127.0.0.1:4000/?token=X";
  test("cdp Page.navigate params are scanned, whatever the verb", () => {
    expect(agentAskRefusal({ op: "cdp", method: "Page.navigate", params: { url: T } }, "alba", "cdp") ?? "").toContain("token=");
  });
  test("a fourth level down is scanned", () => {
    const deep = { op: "do", steps: [{ op: "do", args: { a: { b: { c: [{ d: T }] } } } }] };
    expect(bodyCarriesToken(deep)).toBe(true);
    expect(agentAskRefusal(deep, "alba", "do") ?? "").toContain("token=");
  });
  test("a relative URL with an encoded key", () => {
    expect(urlCarriesToken("/?%74oken=X")).toBe(true);
    expect(urlCarriesToken("?TOKEN=X")).toBe(true);
  });
  test("a hash query with an encoded key", () => {
    expect(urlCarriesToken("http://h/#/p?%74oken=X")).toBe(true);
    expect(urlCarriesToken("/#/p?a=1&%54oken=X")).toBe(true);
    expect(urlCarriesToken("http://h/#/p?a=1")).toBe(false);
    expect(urlCarriesToken("plain words, token=X in prose")).toBe(false);
  });
});
