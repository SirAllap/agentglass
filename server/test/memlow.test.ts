import { describe, expect, test } from "bun:test";
// electron/ is plain CommonJS with no build step.
const { memoryLowCommand, ownUnit, DEFAULT_LOW } = require("../../electron/memlow.js");

const scope = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-agentglass-electron-4242.scope\n";
const launcher = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-Hyprland-gtk\\x2dlaunch-7711.scope\n";
const service = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/orbit.service\n";

describe("memoryLowCommand", () => {
  test("a user scope gets MemoryLow with the default", () => {
    expect(memoryLowCommand(scope, "linux", undefined, 4242)).toEqual({
      unit: "app-agentglass-electron-4242.scope",
      args: ["--user", "set-property", "--runtime", "app-agentglass-electron-4242.scope", `MemoryLow=${DEFAULT_LOW}`],
    });
  });
  test("an override replaces the size", () => {
    expect(memoryLowCommand(scope, "linux", "2G", 4242)?.args.at(-1)).toBe("MemoryLow=2G");
  });
  test("launcher scope first, own-pid scope later: only the own one is accepted", () => {
    expect(memoryLowCommand(launcher, "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand(service, "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand(scope, "linux", undefined, 4243)).toBeNull();
    expect(memoryLowCommand(scope, "linux", undefined, 4242)?.unit).toBe("app-agentglass-electron-4242.scope");
  });
  // The pid alone let two cases through the wrong way: a launcher that execs the
  // app keeps the pid, and the app run as a user service has no scope at all.
  test("a launcher scope that carries the app's own pid is still the launcher's", () => {
    const sameNumber = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-Hyprland-gtk\\x2dlaunch-4242.scope\n";
    expect(memoryLowCommand(sameNumber, "linux", undefined, 4242)).toBeNull();
    const pane = "0::/user.slice/user-1000.slice/user@1000.service/tmux-spawn-4242.scope\n";
    expect(memoryLowCommand(pane, "linux", undefined, 4242)).toBeNull();
  });
  test("the app started as a user service is protected by its service", () => {
    const own = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentglass.service\n";
    expect(memoryLowCommand(own, "linux", undefined, 4242)).toEqual({
      unit: "agentglass.service",
      args: ["--user", "set-property", "--runtime", "agentglass.service", `MemoryLow=${DEFAULT_LOW}`],
    });
    // Somebody else's service is not ours because we happen to run inside it.
    expect(memoryLowCommand(service, "linux", undefined, 4242)).toBeNull();
    expect(ownUnit("app-agentglass-electron-4242.scope", 4242)).toBe(true);
    expect(ownUnit("app-agentglass-electron-4242.scope", 4243)).toBe(false);
  });
  test("off, 0 and junk skip", () => {
    for (const v of ["off", "0", "lots", "1.5G"]) expect(memoryLowCommand(scope, "linux", v, 4242)).toBeNull();
  });
  test("system units, session scopes, v1 and empty skip", () => {
    expect(memoryLowCommand("0::/system.slice/sshd.service\n", "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand("0::/user.slice/user-1000.slice/session-3.scope\n", "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand("12:memory:/user.slice\n1:name=systemd:/user.slice/x.scope\n", "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand("0::/\n", "linux", undefined, 4242)).toBeNull();
    expect(memoryLowCommand("", "linux", undefined, 4242)).toBeNull();
  });
  test("not linux skips", () => {
    expect(memoryLowCommand(scope, "darwin", undefined, 4242)).toBeNull();
    expect(memoryLowCommand(scope, "win32", undefined, 4242)).toBeNull();
  });
});

describe("memory.low drop-in (survives a reboot)", () => {
  const { dropInText, installDropIn, DROPIN_DIR, DROPIN_FILE } = require("../../electron/memlow.js");
  const { mkdtempSync, readFileSync, existsSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");

  test("dash-prefix dir matches every app-agentglass-electron-<pid>.scope", () => {
    expect(DROPIN_DIR).toBe("app-agentglass-electron-.scope.d");
    expect(`app-agentglass-electron-4242.scope`.startsWith(DROPIN_DIR.replace(/\.scope\.d$/, ""))).toBe(true);
  });
  test("text: [Scope] MemoryLow with the default, or the override", () => {
    expect(dropInText(undefined)).toContain(`[Scope]\nMemoryLow=${DEFAULT_LOW}\n`);
    expect(dropInText("2G")).toContain("MemoryLow=2G\n");
  });
  test("off, 0 or a bad size: no drop-in", () => {
    for (const v of ["off", "0", "none", "FALSE", "lots"]) expect(dropInText(v)).toBeNull();
  });
  test("install writes under systemd/user, off removes it", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-memlow-"));
    try {
      const file = join(home, "systemd", "user", DROPIN_DIR, DROPIN_FILE);
      installDropIn(home, undefined);
      expect(readFileSync(file, "utf8")).toContain(`MemoryLow=${DEFAULT_LOW}`);
      installDropIn(home, "off");
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(home, "systemd", "user", DROPIN_DIR))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
