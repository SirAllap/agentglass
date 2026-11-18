/*
 * The memory reserve, all the way up.
 *
 * The app's own unit said MemoryLow=1536M and the kernel honoured none of it:
 * the three systemd levels above it held 0, and a level without a reserve
 * cancels the ones under it. Stalls of 2 to 4.5 s followed, with the server's
 * memory read back from swap. What is pinned here: which levels are named as
 * missing, the exact command a person is asked a password for, and that
 * nothing but the person's own press reaches it.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOW, ROOT_SCRIPT, applyReserve, ownerOf, parseLow, promptRefusal, reserveBytes, reserveChain, reserveReport,
  reserveVerdict, rootArgv, userArgvs, type ReserveIo, type Run,
} from "../src/memreserve.ts";
import type { MemoryReserveLevel } from "../../shared/memoryReserve.ts";

const GB = 1024 ** 3, MB = 1024 ** 2;
const CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-agentglass-electron-4242.scope\n";
const WANT = 1536 * MB;

/** A machine whose levels hold what `lows` says, keyed by unit; anything unnamed holds 0. */
const machine = (lows: Record<string, string>, over: Partial<ReserveIo> = {}): ReserveIo => ({
  platform: "linux",
  cgroup: () => CGROUP,
  low: (path) => lows[path.split("/").pop()!] ?? "0",
  systemd: () => true,
  ram: () => 32 * GB,
  override: () => undefined,
  ...over,
});
const ALL = { "user.slice": "2147483648", "user-1000.slice": "2147483648", "user@1000.service": "2147483648", "app.slice": "2147483648", "app-agentglass-electron-4242.scope": String(WANT) };

describe("how much is reserved", () => {
  test("the app's own default, and the same one the desktop shell sets on its scope", async () => {
    expect(reserveBytes(undefined, 32 * GB)).toBe(WANT);
    const shell = await Bun.file(new URL("../../electron/memlow.js", import.meta.url)).text();
    expect(shell).toContain(`const DEFAULT_LOW = "${DEFAULT_LOW}";`);
  });
  test("never more than a quarter of the machine's memory", () => {
    expect(reserveBytes(undefined, 4 * GB)).toBe(1 * GB);
    expect(reserveBytes("8G", 16 * GB)).toBe(4 * GB);
    expect(reserveBytes("512M", 16 * GB)).toBe(512 * MB);
  });
  test("switched off, or a size systemd would not take, is no reserve at all", () => {
    for (const off of ["0", "off", "none", "false", "lots", "1.5G"]) expect(reserveBytes(off, 32 * GB)).toBeNull();
  });
});

describe("which levels there are", () => {
  test("from the app's own unit up to user.slice", () => {
    expect(reserveChain(CGROUP)).toEqual(["app-agentglass-electron-4242.scope", "app.slice", "user@1000.service", "user-1000.slice", "user.slice"]);
  });
  test("no chain outside a systemd user session", () => {
    expect(reserveChain("0::/system.slice/orbit.service\n")).toBeNull();
    expect(reserveChain("12:memory:/user.slice\n")).toBeNull();
    expect(reserveChain("0::/user.slice/user-1000.slice/session-2.scope\n")).toBeNull();
    // A name no systemd unit has is not passed on to a command line.
    expect(reserveChain("0::/user.slice/user-1000.slice/user@1000.service/app.slice/x; reboot.scope\n")).toBeNull();
  });
  test("three belong to the system, the rest to the person, the last to the app", () => {
    const chain = reserveChain(CGROUP)!;
    expect(chain.map((u, i) => ownerOf(u, i))).toEqual(["app", "user", "root", "root", "root"]);
  });
  test("memory.low as the kernel prints it", () => {
    expect(parseLow("2147483648\n")).toBe(2147483648);
    expect(parseLow("max\n")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseLow(null)).toBeNull();
    expect(parseLow("")).toBeNull();
  });
});

describe("whether the reserve is honoured", () => {
  const level = (unit: string, low: number | null): MemoryReserveLevel => ({ unit, low, owner: "user" });
  test("one level below the amount cancels it, and is named, top first", () => {
    const levels = [level("app-agentglass-electron-4242.scope", WANT), level("app.slice", 0), level("user@1000.service", 2 * GB), level("user-1000.slice", 2 * GB), level("user.slice", 0)];
    expect(reserveVerdict(levels, WANT)).toEqual({ state: "missing", missing: ["user.slice", "app.slice"] });
  });
  test("a level that could not be read is not a reserve", () => {
    expect(reserveVerdict([level("app.slice", null)], WANT).missing).toEqual(["app.slice"]);
  });
  test("the machine as it was measured: the scope set, everything above it at 0", () => {
    const r = reserveReport(machine({ "app-agentglass-electron-4242.scope": String(WANT) }));
    expect(r.state).toBe("missing");
    expect(r.want).toBe(WANT);
    expect(r.missing).toEqual(["user.slice", "user-1000.slice", "user@1000.service", "app.slice"]);
    expect(r.levels.find((l) => l.unit === "user.slice")).toEqual({ unit: "user.slice", low: 0, owner: "root" });
  });
  test("every level holding it is effective", () => {
    expect(reserveReport(machine(ALL))).toMatchObject({ state: "effective", missing: [] });
  });
  test("each level is read at its own path", () => {
    const asked: string[] = [];
    reserveReport(machine({}, { low: (p) => { asked.push(p); return "0"; } }));
    expect(asked).toEqual([
      "user.slice/user-1000.slice/user@1000.service/app.slice/app-agentglass-electron-4242.scope",
      "user.slice/user-1000.slice/user@1000.service/app.slice",
      "user.slice/user-1000.slice/user@1000.service",
      "user.slice/user-1000.slice",
      "user.slice",
    ]);
  });
  test("not applicable off Linux, without systemd, outside a user session, or switched off", () => {
    expect(reserveReport(machine({}, { platform: "darwin" })).state).toBe("not-applicable");
    expect(reserveReport(machine({}, { systemd: () => false })).state).toBe("not-applicable");
    expect(reserveReport(machine({}, { cgroup: () => "0::/system.slice/orbit.service\n" })).state).toBe("not-applicable");
    const off = reserveReport(machine({}, { override: () => "off" }));
    expect(off.state).toBe("not-applicable");
    expect(off.why).toContain("AGENTGLASS_MEMORY_LOW");
  });
});

describe("the commands", () => {
  const units = ["app-agentglass-electron-4242.scope", "app.slice", "user@1000.service", "user-1000.slice", "user.slice"];
  test("one prompt for the three system levels: a fixed script, the values as its arguments", () => {
    expect(rootArgv(units, WANT)).toEqual([
      "pkexec", "/bin/sh", "-c", ROOT_SCRIPT, "agentglass-memory-reserve", "1610612736",
      "user@1000.service", "user-1000.slice", "user.slice",
    ]);
    // The script names no unit and no amount: nothing is written into its text.
    expect(ROOT_SCRIPT).toBe('v="$1"; shift; for u in "$@"; do systemctl set-property "$u" "MemoryLow=$v" || exit 1; done');
    expect(ROOT_SCRIPT).not.toContain("--runtime");
  });
  test("undo is the same command with 0", () => {
    expect(rootArgv(units, 0)!.slice(5)).toEqual(["0", "user@1000.service", "user-1000.slice", "user.slice"]);
  });
  test("nothing to ask for without a system level, or with an amount that is not a whole number of bytes", () => {
    expect(rootArgv(["app.slice"], WANT)).toBeNull();
    expect(rootArgv(units, 1.5)).toBeNull();
    expect(rootArgv(units, -1)).toBeNull();
  });
  test("the person's own slice needs no prompt, and is persistent", () => {
    const levels = units.map((unit, i) => ({ unit, low: 0, owner: ownerOf(unit, i) }));
    expect(userArgvs(levels, WANT)).toEqual([["systemctl", "--user", "set-property", "app.slice", "MemoryLow=1610612736"]]);
  });
  test("a closed prompt and a missing agent are said in words", () => {
    expect(promptRefusal(126, "")).toContain("closed");
    expect(promptRefusal(127, "")).toContain("could not ask");
    expect(promptRefusal(1, "Failed to set unit properties")).toContain("Failed to set unit properties");
  });
});

describe("pressing the button", () => {
  const recorder = (codes: number[] = []) => {
    const ran: string[][] = [];
    const run: Run = async (argv) => { ran.push(argv); return { code: codes[ran.length - 1] ?? 0, err: "" }; };
    return { ran, run };
  };
  test("the system levels first, in one command, then the person's own", async () => {
    const { ran, run } = recorder();
    const res = await applyReserve("apply", machine({ "app-agentglass-electron-4242.scope": String(WANT) }), run, "/usr/bin/pkexec");
    expect(ran).toEqual([
      ["/usr/bin/pkexec", "/bin/sh", "-c", ROOT_SCRIPT, "agentglass-memory-reserve", "1610612736", "user@1000.service", "user-1000.slice", "user.slice"],
      ["systemctl", "--user", "set-property", "app.slice", "MemoryLow=1610612736"],
    ]);
    expect(res.ok).toBe(true);
  });
  test("a closed prompt changes nothing: the person's own slice is not touched either", async () => {
    const { ran, run } = recorder([126]);
    const res = await applyReserve("apply", machine({}), run, "/usr/bin/pkexec");
    expect(ran.length).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("closed");
  });
  test("undo writes 0 on the same levels", async () => {
    const { ran, run } = recorder();
    await applyReserve("undo", machine(ALL), run, "/usr/bin/pkexec");
    expect(ran[0]!.slice(5)).toEqual(["0", "user@1000.service", "user-1000.slice", "user.slice"]);
    expect(ran[1]).toEqual(["systemctl", "--user", "set-property", "app.slice", "MemoryLow=0"]);
  });
  test("nothing is run where it does not apply, or without polkit", async () => {
    const a = recorder();
    expect((await applyReserve("apply", machine({}, { platform: "darwin" }), a.run, "/usr/bin/pkexec")).ok).toBe(false);
    expect(a.ran).toEqual([]);
    const b = recorder();
    const res = await applyReserve("apply", machine({}), b.run, null);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pkexec");
    expect(b.ran).toEqual([]);
  });
});

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("who may press it", () => {
  const at = index.indexOf('if (pathname === "/machine/memory-reserve" && req.method === "POST") {');
  const body = index.slice(at, index.indexOf("\n    }\n", at));
  test("only the person, in the desktop app's own window", () => {
    expect(at).toBeGreaterThan(-1);
    const gate = body.indexOf("personMayPress(caller, desktopOnly(req), deskHeld(), deskKeyOk(req))");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf("trustedCaller(req, from)")).toBeLessThan(gate);
    // Nothing is run before both gates.
    expect(body.indexOf("applyReserve(")).toBeGreaterThan(gate);
  });
  test("that route is the only caller: nothing sets the reserve at startup or on a timer", () => {
    const calls = index.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes("applyReserve("));
    expect(calls.length).toBe(1);
    expect(body).toContain(calls[0]!.trim());
  });
});
