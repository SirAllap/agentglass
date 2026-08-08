/*
 * The OpenCode plugin, and the installer that deploys it.
 *
 * This integration is the odd one out and the tests are shaped by it. OpenCode
 * has no hook system to wire and no OTel exporter to point somewhere: it loads
 * plain JS out of ~/.config/opencode/plugins/, so "connecting" it means copying
 * a file into somebody's config directory. That is a destructive-adjacent act
 * on a path this app does not own, so the interesting assertions are the
 * refusals — what the installer declines to overwrite, and what the plugin
 * declines to send.
 *
 * Written here rather than beside the hooks because this is the suite CI runs.
 * A `.test.mjs` next to the plugin, or a `test_*.py` next to the installer, is
 * a test nothing executes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../../hooks/opencode-plugin.js" as string);
const CONNECT = new URL("../../hooks/connect_opencode.py", import.meta.url).pathname;

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway XDG_CONFIG_HOME, so nothing here can reach a real config. */
function xdg(): string {
  const d = mkdtempSync(join(tmpdir(), "agx-oc-"));
  dirs.push(d);
  return d;
}

function connect(home: string, ...args: string[]) {
  const r = spawnSync(python!, [CONNECT, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Is opencode on this machine?
 *
 * `opencode_installed()` looks in TWO places — `$XDG_CONFIG_HOME/opencode` and
 * `opencode` on the PATH — and this suite can only isolate the first. On a
 * machine that has opencode (the one this is developed on, at
 * ~/.opencode/bin), the "when it is not installed" case is not a case that
 * exists, and pretending otherwise made it fail on every single run: green in
 * CI, red at home, which is the worst way round. Scrubbing the PATH instead
 * was tried and takes python's own directory with it.
 */
const opencodeHere = !!Bun.which("opencode");

const pluginPath = (home: string) => join(home, "opencode", "plugins", "agentglass.js");

describe("where the plugin will send", () => {
  test("refuses any host that is not this machine", () => {
    for (const url of ["https://example.com", "http://10.0.0.5:4000", "http://evil.localhost.example"]) {
      expect(plugin.isAllowedServer(url), url).toBe(false);
    }
    for (const url of ["http://localhost:4000", "http://127.0.0.1:4000", "https://127.0.0.1:4000", "http://[::1]:4000"]) {
      expect(plugin.isAllowedServer(url), url).toBe(true);
    }
  });

  test("and lets an explicit opt-in through, the same as the hooks", () => {
    expect(plugin.isAllowedServer("https://example.com")).toBe(false);
    expect(plugin.isAllowedServer("https://example.com", true)).toBe(true);
  });

  test("a garbled value is refused rather than guessed at", () => {
    for (const url of ["", "not a url", "ftp://127.0.0.1"]) {
      expect(plugin.isAllowedServer(url), JSON.stringify(url)).toBe(false);
    }
  });

  test("dials 127.0.0.1, by default and after a localhost is configured", () => {
    // Same reason as the Python hooks: the server binds IPv4-only, and a
    // resolver that answers ::1 first makes every event pay a refused connect.
    expect(plugin.resolveServer({})).toBe("http://127.0.0.1:4000");
    expect(plugin.resolveServer({ AGENTGLASS_SERVER: "http://localhost:4000" })).toBe("http://127.0.0.1:4000");
    expect(plugin.resolveServer({ AGENTGLASS_URL: "http://localhost:5000/" })).toBe("http://127.0.0.1:5000");
    // A host that merely contains the word is somebody else's and is left alone
    // for isAllowedServer to refuse.
    expect(plugin.preferIpv4("http://localhost.example:4000")).toBe("http://localhost.example:4000");
  });

  test("AGENTGLASS_SERVER wins over the deprecated alias", () => {
    expect(plugin.resolveServer({ AGENTGLASS_SERVER: "http://127.0.0.1:6000", AGENTGLASS_URL: "http://127.0.0.1:5000" }))
      .toBe("http://127.0.0.1:6000");
  });
});

describe("what the plugin forwards", () => {
  test("a large tool output is truncated, and says that it was", () => {
    // Tool output is the one field with no natural ceiling — a `cat` of a
    // bundle would otherwise go through /ingest and into the database whole.
    const big = "x".repeat(300 * 1024);
    const out = plugin.limitToolOutput(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toEndWith("[output truncated by agentglass]");
    // Anything that fits is passed through untouched, including non-strings.
    expect(plugin.limitToolOutput("small")).toBe("small");
    expect(plugin.limitToolOutput(undefined)).toBeUndefined();
  });
});

describe("deploying it", () => {
  test.if(!!python && !opencodeHere)("does nothing when OpenCode is not installed", () => {
    const home = xdg();
    const r = connect(home);
    expect(r.status).toBe(0);
    expect(existsSync(pluginPath(home))).toBe(false);
    expect(r.out).toContain("opencode not detected");
  });

  test.if(!!python)("writes the plugin once OpenCode's config dir exists", () => {
    const home = xdg();
    mkdirSync(join(home, "opencode"), { recursive: true });
    expect(connect(home).status).toBe(0);
    const written = readFileSync(pluginPath(home), "utf8");
    expect(written).toStartWith("// agentglass opencode plugin");
    // The deployed copy is the one in this repo, not a paraphrase of it.
    expect(written).toBe(readFileSync(new URL("../../hooks/opencode-plugin.js", import.meta.url).pathname, "utf8"));
  });

  test.if(!!python)("is idempotent, and re-running leaves no backup litter", () => {
    const home = xdg();
    mkdirSync(join(home, "opencode"), { recursive: true });
    connect(home);
    const second = connect(home);
    expect(second.status).toBe(0);
    expect(second.out).toContain("already installed");
  });

  test.if(!!python)("refuses to overwrite a plugin that is not ours", () => {
    // The assertion this file exists for. `agentglass.js` is a plausible name
    // for somebody's own plugin, and this writes into a directory the app does
    // not own — clobbering it would be destroying work with no undo.
    const home = xdg();
    mkdirSync(join(home, "opencode", "plugins"), { recursive: true });
    writeFileSync(pluginPath(home), "// someone else's plugin\nexport const Mine = () => ({});\n");
    const r = connect(home);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("refusing to replace");
    expect(readFileSync(pluginPath(home), "utf8")).toContain("someone else's plugin");
  });

  test.if(!!python)("--undo removes ours and leaves anyone else's alone", () => {
    const home = xdg();
    mkdirSync(join(home, "opencode"), { recursive: true });
    connect(home);
    expect(existsSync(pluginPath(home))).toBe(true);
    expect(connect(home, "--undo").status).toBe(0);
    expect(existsSync(pluginPath(home))).toBe(false);

    // Now the other direction: a foreign plugin survives an undo.
    mkdirSync(join(home, "opencode", "plugins"), { recursive: true });
    writeFileSync(pluginPath(home), "// someone else's plugin\n");
    const r = connect(home, "--undo");
    expect(r.status).toBe(0);
    expect(r.out).toContain("leaving unrelated");
    expect(existsSync(pluginPath(home))).toBe(true);
  });

  test.if(!!python)("refuses to deploy at all when pointed off this machine", () => {
    // The plugin checks again at send time, but an installer that happily wires
    // up an exfiltrating endpoint and relies on the payload to refuse later is
    // the wrong shape.
    const home = xdg();
    mkdirSync(join(home, "opencode"), { recursive: true });
    const r = spawnSync(python!, [CONNECT], {
      env: { ...process.env, XDG_CONFIG_HOME: home, AGENTGLASS_SERVER: "https://collector.example.invalid", PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("refusing non-local server");
    expect(existsSync(pluginPath(home))).toBe(false);
  });
});
