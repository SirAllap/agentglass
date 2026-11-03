/*
 * The helpers the boot reap finds without a ledger row.
 *
 * Measured on one machine 12.5 h after the ledger landed: four
 * `/usr/bin/udisksctl monitor` alive with systemd as their parent, older than
 * the fix, and no ledger file in the state dir — so `reapRecordedChildren` had
 * nothing to read. The halves are tested the way they fail: an orphaned helper
 * of this user against one whose server is still running, one of another user,
 * and the similar command lines a name match would take for ours.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  classifyOwnHelpers, initPidsOf, parsePs, reapOwnHelpers,
} from "../src/ownhelpers.ts";

const MY_UID = typeof process.getuid === "function" ? process.getuid() : -1;

const line = (pid: number, ppid: number, uid: number, comm: string, cmd: string): string =>
  `${pid} ${ppid} ${uid} ${comm} ${cmd}`;

/** One machine as `ps -eo pid=,ppid=,uid=,comm=,args=` prints it: init, this
 *  user's systemd, a live agentglass server, and helpers in every state. */
const MACHINE = [
  line(1, 0, 0, "systemd", "/usr/lib/systemd/systemd --system"),
  line(1487, 1, MY_UID, "systemd", "/usr/lib/systemd/systemd --user"),
  line(600, 1, MY_UID, "bun", "bun /home/dev/code/agentglass/server/src/index.ts"),
  line(500, 1487, MY_UID, "udisksctl", "/usr/bin/udisksctl monitor"),
  line(501, 1487, MY_UID, "gio", "/usr/bin/gio mount -m"),
  line(502, 600, MY_UID, "udisksctl", "/usr/bin/udisksctl monitor"),
  line(503, 1487, MY_UID + 1, "udisksctl", "/usr/bin/udisksctl monitor"),
  line(504, 1487, MY_UID, "gio", "/usr/bin/gio open /home/dev"),
  line(505, 1487, MY_UID, "udisksctl", "/usr/bin/udisksctl dump"),
  line(506, 1487, MY_UID, "udisksctl", "/usr/bin/udisksctl monitor /dev/sdb"),
  line(507, 1487, MY_UID, "gio", "/bin/sh /tmp/agx-volumes-acme/bin/gio mount -m"),
  line(508, 1487, MY_UID, "inotifywait", "inotifywait -m -q -e close_write /home/dev/.local/state/acme"),
].join("\n");

const rows = parsePs(MACHINE);
const ctx = { selfPid: 4242, uid: MY_UID, initPids: initPidsOf(rows) };

const reaped = (): number[] => classifyOwnHelpers(rows, ctx).map((r) => r.pid).sort((a, b) => a - b);

/** A `ps` that always answers the same machine, and a start time keyed by pid. */
function fakeDeps(starts: Record<number, string | string[]> = {}, rowText = MACHINE) {
  const sent: { pid: number; sig: NodeJS.Signals }[] = [];
  const reads = new Map<number, number>();
  return {
    sent,
    deps: {
      ps: () => rowText,
      signal: (pid: number, sig: NodeJS.Signals) => { sent.push({ pid, sig }); },
      startOf: (pid: number) => {
        const v = starts[pid];
        if (Array.isArray(v)) {
          const i = reads.get(pid) ?? 0;
          reads.set(pid, i + 1);
          return v[Math.min(i, v.length - 1)] ?? "";
        }
        return v ?? "1000";
      },
      graceMs: 0,
    },
  };
}

describe("the command line is ours, exactly", () => {
  test("parses ps without mistaking an argument for a column", () => {
    const [r] = parsePs(line(9, 8, MY_UID, "gio", "/usr/bin/gio open /home/acme/a b"));
    expect(r).toEqual({ pid: 9, ppid: 8, uid: MY_UID, comm: "gio", cmd: "/usr/bin/gio open /home/acme/a b" });
  });

  test("init is pid 1 and the user's own systemd", () => {
    expect(initPidsOf(rows).sort((a, b) => a - b)).toEqual([1, 1487]);
  });

  test("takes the two helpers this server starts, and nothing that looks like them", () => {
    expect(reaped()).toEqual([500, 501]);
  });

  test("leaves a helper whose server is still running", () => {
    expect(reaped()).not.toContain(502);
    expect(reaped()).not.toContain(600); // the server itself, never a helper
  });

  test("leaves another user's helper", () => {
    expect(reaped()).not.toContain(503);
  });

  test("never takes a name for a command line", () => {
    for (const pid of [504, 505, 506, 507, 508]) expect(reaped()).not.toContain(pid);
  });

  test("never lists itself", () => {
    const self = classifyOwnHelpers(rows, { ...ctx, selfPid: 500 });
    expect(self.map((r) => r.pid)).not.toContain(500);
  });
});

describe("the boot reap", () => {
  test("asks only the orphaned helpers to stop", () => {
    const { sent, deps } = fakeDeps();
    expect(reapOwnHelpers(deps)).toBe(2);
    expect(sent).toEqual([{ pid: 500, sig: "SIGTERM" }, { pid: 501, sig: "SIGTERM" }]);
  });

  test("does nothing when there is nothing of ours", () => {
    const { sent, deps } = fakeDeps({}, line(1, 0, 0, "systemd", "/usr/lib/systemd/systemd --system"));
    expect(reapOwnHelpers(deps)).toBe(0);
    expect(sent).toEqual([]);
  });

  test("kills after the grace only the process that is still the same one", async () => {
    // 500 is still there; 501's pid now carries another start time.
    const { sent, deps } = fakeDeps({ 500: ["1000", "1000"], 501: ["2000", "3000"] });
    reapOwnHelpers(deps);
    await Bun.sleep(20);
    expect(sent.filter((s) => s.sig === "SIGKILL")).toEqual([{ pid: 500, sig: "SIGKILL" }]);
  });

  test("a helper whose start time cannot be read is left alone", () => {
    const { sent, deps } = fakeDeps({ 500: "", 501: "" });
    expect(reapOwnHelpers(deps)).toBe(0);
    expect(sent).toEqual([]);
  });

  test("a ps that cannot run is not an error at boot", () => {
    expect(reapOwnHelpers({ ps: () => { throw new Error("no ps"); } })).toBe(0);
  });

  test("runs at boot, next to the ledger's reap", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    expect(src.includes("reapOwnHelpers()")).toBe(true);
  });
});
