/*
 * An isolated instance must not reach the real engine's tmux server.
 *
 * A redirected config dir already gets a conf file of its own (see
 * tmux-conf-isolation.test.ts). That kept a throwaway instance from rewriting
 * the real engine's file, and did nothing about where the throwaway's own file
 * was SOURCED: every boot runs `source-file <conf>` against `-L agentglass`,
 * and with no TMUX_TMPDIR of its own that is /tmp/tmux-<uid>/agentglass — the
 * installed app's engine. A throwaway config sets no prefix, so its conf says
 * `set -g prefix C-b`, and the real engine sat on C-b until the real app's
 * prefix heal (once per 30 s) put it back. Measured four times in half an
 * hour, each time as a test run booted a server.
 *
 * Two ways in, and both are pinned here: no TMUX_TMPDIR at all, and a
 * TMUX_TMPDIR that has been removed — tmux falls back to /tmp/tmux-<uid> for
 * that one rather than failing.
 *
 * The boot cases run the real entry point against a tmux stub that only
 * records its argv, so nothing here can reach a live server even when the rule
 * is broken.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { engineSocketArgs, tmuxSocket } from "../src/tmuxbin.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const SAVED = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  AGENTGLASS_TMUX_SOCKET: process.env.AGENTGLASS_TMUX_SOCKET,
};
function restore() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
afterEach(restore);
afterAll(restore);

const isolatedConfig = () => join(mkdtempSync(join(tmpdir(), "agx-sock-")), "config");

describe("the engine's socket name", () => {
  test("the ordinary install keeps `agentglass`", () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.TMUX_TMPDIR;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    expect(tmuxSocket()).toBe("agentglass");
  });

  test("a redirected config with tmux's shared directory gets a socket of its own", () => {
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    delete process.env.TMUX_TMPDIR;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    expect(tmuxSocket()).toMatch(/^agentglass-[0-9a-f]{8}$/);
    // Naming /tmp outright is the same directory tmux falls back to.
    process.env.TMUX_TMPDIR = "/tmp/";
    expect(tmuxSocket()).toMatch(/^agentglass-[0-9a-f]{8}$/);
  });

  test("and the same one across restarts, and a different one per instance", () => {
    const dir = isolatedConfig();
    delete process.env.TMUX_TMPDIR;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    process.env.XDG_CONFIG_HOME = dir;
    const first = tmuxSocket();
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    const other = tmuxSocket();
    process.env.XDG_CONFIG_HOME = dir;
    expect(tmuxSocket()).toBe(first);
    expect(other).not.toBe(first);
  });

  test("a redirected config that is not a temporary one keeps the plain name", () => {
    // Somebody's XDG_CONFIG_HOME can live anywhere. Renaming an installed app's
    // socket would orphan every pane on the server it is running. Never created.
    process.env.XDG_CONFIG_HOME = join(homedir(), ".agx-sock-never-made", "config");
    delete process.env.TMUX_TMPDIR;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    expect(tmuxSocket()).toBe("agentglass");
  });

  test("a TMUX_TMPDIR of the instance's own keeps the plain name", () => {
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "agx-sock-tmux-"));
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    expect(tmuxSocket()).toBe("agentglass");
  });

  test("a config dir not made yet, under a linked temp dir, keeps one name once it is made", () => {
    // Where /tmp is a link (macOS), a path that exists realpaths through it and
    // one that does not stays lexical: the answer must not change between the two.
    const target = mkdtempSync(join(tmpdir(), "agx-sock-target-"));
    const link = `${target}-link`;
    symlinkSync(target, link);
    process.env.XDG_CONFIG_HOME = join(link, "config");
    delete process.env.TMUX_TMPDIR;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    const before = tmuxSocket();
    mkdirSync(join(link, "config", "agentglass"), { recursive: true });
    expect(before).toMatch(/^agentglass-[0-9a-f]{8}$/);
    expect(tmuxSocket()).toBe(before);
  });

  test("an explicit AGENTGLASS_TMUX_SOCKET still wins", () => {
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    delete process.env.TMUX_TMPDIR;
    process.env.AGENTGLASS_TMUX_SOCKET = "agx-sock-explicit";
    expect(tmuxSocket()).toBe("agx-sock-explicit");
  });
});

describe("the engine is named by path", () => {
  test("a TMUX_TMPDIR that is gone is made, never fallen back from", () => {
    const gone = join(mkdtempSync(join(tmpdir(), "agx-sock-gone-")), "tmux");
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    process.env.TMUX_TMPDIR = gone;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    // Only paths are named until a call may start the server.
    expect(existsSync(gone)).toBe(false);
    expect(engineSocketArgs()[0]).toBe("-S");
    expect(existsSync(gone)).toBe(false);
    const [flag, file] = engineSocketArgs(true);
    expect(flag).toBe("-S");
    expect(file!.startsWith(`${gone}/`)).toBe(true);
    expect(existsSync(join(file!, ".."))).toBe(true);
  });

  test("a socket directory open to others is handed back to tmux's own check", () => {
    // `-S` skips the check `-L` makes, so a directory somebody else could write
    // is not used by path: `-L` goes back to tmux, which refuses it itself.
    const base = mkdtempSync(join(tmpdir(), "agx-sock-open-"));
    const dir = join(base, `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    process.env.XDG_CONFIG_HOME = isolatedConfig();
    process.env.TMUX_TMPDIR = base;
    delete process.env.AGENTGLASS_TMUX_SOCKET;
    expect(engineSocketArgs(true)[0]).toBe("-L");
    chmodSync(dir, 0o700);
    expect(engineSocketArgs(true)[0]).toBe("-S");
  });
});

const LIVE = `/tmp/tmux-${process.getuid?.() ?? 0}/agentglass`;

async function bootAndRecord(tmuxTmpdir: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "agx-sock-boot-"));
  const stubDir = join(dir, "bin");
  mkdirSync(stubDir);
  const log = join(dir, "tmux-calls");
  // Records every call and answers only the version probe: no server is ever
  // reached, whichever socket the code asked for.
  const stub = join(stubDir, "tmux");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in *-V*) echo "tmux 3.4"; exit 0;; esac\nexit 1\n`);
  chmodSync(stub, 0o755);
  const port = 4960 + Math.floor(Math.random() * 30);
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG || "C.UTF-8",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_PATH: stub,
      // The case under test, shared with the installed app or gone from under
      // it. The stub above is what makes that safe to run.
      TMUX_TMPDIR: tmuxTmpdir,
    },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    for (let i = 0; i < 200; i++) {
      if (existsSync(log)) {
        const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
        const sourced = calls.filter((c) => c.includes("source-file"));
        if (sourced.length) return sourced;
      }
      await Bun.sleep(100);
    }
    return [];
  } finally {
    proc.kill();
    await proc.exited;
  }
}

function expectNotTheEngine(sourced: string[]) {
  expect(sourced.length, "the boot never sourced its conf; nothing was tested").toBeGreaterThan(0);
  for (const c of sourced) {
    expect(c).not.toMatch(/(^|\s)-L\s/);
    const m = c.match(/-S (\S+)/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe(LIVE);
  }
}

describe("a booted server with a temporary config", () => {
  test("and tmux's shared directory sources its conf into a server of its own", async () => {
    const sourced = await bootAndRecord("/tmp");
    expectNotTheEngine(sourced);
    expect(sourced[0]!).toMatch(/-S \/tmp\/tmux-\d+\/agentglass-[0-9a-f]{8} /);
  }, SERVER_BOOT_MS);

  test("and a TMUX_TMPDIR that was removed does not fall back to the engine", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "agx-sock-gone-")), "tmux");
    const sourced = await bootAndRecord(gone);
    expectNotTheEngine(sourced);
    expect(sourced[0]!).toContain(`-S ${gone}/`);
  }, SERVER_BOOT_MS);
});
