/*
 * Stopping a turn has to end the job, not just the CLI that launched it (#195).
 *
 * The POSIX case is exercised for real — a process group with a grandchild in
 * it, stopped, then asked whether the grandchild is still there — because that
 * is the property the Stop button promises and a mock of it would prove
 * nothing. The Windows case is exercised through an injected platform and
 * runner, because `taskkill` does not exist here; what is asserted there is the
 * command, which is the whole of what this module decides.
 */
import { describe, expect, test } from "bun:test";
import { stopTree, type Runner } from "../src/proctree.ts";

/**
 * Is this pid a process that is still doing something?
 *
 * Not `process.kill(pid, 0)`, which answers true for a zombie — and a zombie is
 * exactly what a killed grandchild is for the moment between dying and being
 * reaped. Measured while writing this: the group SIGTERM lands, the `sleep`
 * goes to state `Z`, and `kill(pid, 0)` still succeeds for a second or two
 * afterwards because the parent shell died first and init has not collected it
 * yet. A test on that signal would have failed while the code worked.
 */
const alive = (pid: number): boolean => {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat.length > 0 && !stat.startsWith("Z");
};

const settle = () => Bun.sleep(300);

describe("stopping a turn on Windows", () => {
  const fake = () => {
    const cmds: string[][] = [];
    let killed = 0;
    const run: Runner = (cmd) => { cmds.push(cmd); return { exitCode: 0 }; };
    return { cmds, run, killed: () => killed, proc: { pid: 4321, kill: () => { killed++; } } };
  };

  test("walks the tree with taskkill, since setsid does not exist there", () => {
    const f = fake();
    stopTree(f.proc, false, "win32", f.run);
    expect(f.cmds).toEqual([["taskkill", "/T", "/F", "/PID", "4321"]]);
  });

  test("kills the CLI itself first, so a machine with no taskkill still stops something", () => {
    const f = fake();
    stopTree(f.proc, false, "win32", f.run);
    expect(f.killed()).toBe(1);
  });

  test("a taskkill that is not installed is not an error — the turn is over either way", () => {
    const f = fake();
    const throws: Runner = () => { throw new Error("spawn taskkill ENOENT"); };
    expect(() => stopTree(f.proc, false, "win32", throws)).not.toThrow();
    expect(f.killed()).toBe(1);
  });

  test("`grouped` is meaningless there and changes nothing", () => {
    const a = fake(); const b = fake();
    stopTree(a.proc, true, "win32", a.run);
    stopTree(b.proc, false, "win32", b.run);
    expect(a.cmds).toEqual(b.cmds);
  });
});

describe("stopping a turn on this machine", () => {
  test("a grouped turn takes its grandchildren with it", async () => {
    const setsid = Bun.which("setsid");
    if (!setsid) return; // no process groups to test — the Windows branch above covers that shape

    // A shell that starts a long sleep and reports its pid, then waits: the
    // sleep is the "test run the agent kicked off" this feature exists for.
    const proc = Bun.spawn([setsid, "sh", "-c", "sleep 60 & echo $!; wait"], { stdout: "pipe", stderr: "ignore" });
    // One read, not `new Response(...).text()`: that waits for the stream to
    // close, and the shell is still holding it open — which is the point of the
    // fixture. The pid arrives on the first chunk.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const grandchild = Number(new TextDecoder().decode(first.value ?? new Uint8Array()).trim().split("\n")[0]);
    try { await reader.cancel(); } catch { /* the shell is about to go anyway */ }
    expect(Number.isFinite(grandchild) && grandchild > 0).toBe(true);
    expect(alive(grandchild)).toBe(true);

    stopTree(proc, true);
    await settle();

    expect(alive(grandchild)).toBe(false);
    expect(alive(proc.pid)).toBe(false);
  }, 15_000);

  test("an ungrouped turn stops the process it was given", async () => {
    const proc = Bun.spawn(["sh", "-c", "sleep 60"], { stdout: "ignore", stderr: "ignore" });
    expect(alive(proc.pid)).toBe(true);

    stopTree(proc, false);
    await settle();

    expect(alive(proc.pid)).toBe(false);
  }, 15_000);

  test("stopping something already gone is not an error", () => {
    const proc = Bun.spawn(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    expect(() => { stopTree(proc, true); stopTree(proc, false); }).not.toThrow();
  });
});
