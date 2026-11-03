/*
 * The children this server starts must not outlive it, and the next boot must
 * not stop a stranger.
 *
 * Measured on one machine after 2.6 days and dozens of server restarts: 39
 * `udisksctl monitor` processes alive with systemd as their parent, the oldest
 * 2.6 days old. So the halves are tested the way they fail: a real child
 * started through the same code, with the parent process exiting; a ledger
 * record whose pid now belongs to a different process, which must be left
 * alone; and a ledger whose OWNER is still running, whose children are that
 * owner's live children and must survive another server's boot reap.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_GRACE_MS, bootId, ledgerFile, reapRecordedChildren, startStamp, stopChild, trackChild } from "../src/childledger.ts";
import { watchDevices } from "../src/volumes.ts";

const dirs: string[] = [];
const previous = { state: process.env.AGENTGLASS_STATE_DIR, xdg: process.env.XDG_STATE_HOME, db: process.env.AGENTGLASS_DB };

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "child-ledger-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (previous.state === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = previous.state;
  if (previous.xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.xdg;
  if (previous.db === undefined) delete process.env.AGENTGLASS_DB; else process.env.AGENTGLASS_DB = previous.db;
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopped = (pid: number): boolean => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } return true; };

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await Bun.sleep(25); }
  return !alive(pid);
}

function useStateDir(d: string): void {
  process.env.AGENTGLASS_STATE_DIR = d;
  process.env.XDG_STATE_HOME = join(d, "xdg");
  process.env.AGENTGLASS_DB = join(d, "agentglass.db");
}

/** The same kernel field, read here rather than through the module under test. */
function procStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}

const childLedgerModule = join(import.meta.dir, "../src/childledger.ts");

/** A ledger file, written as the owner envelope the module writes. The boot
 *  defaults to this one, because a record without it is meant to be dropped. */
function writeLedgerFile(
  file: string,
  ownerPid: number,
  ownerStart: string,
  children: { pid: number; start: string; cmd?: string; boot?: string }[],
  ownerBoot = bootId(),
): void {
  const rows = children.map((r) => ({ pid: r.pid, start: r.start, boot: r.boot ?? bootId(), cmd: r.cmd ?? "" }));
  writeFileSync(file, JSON.stringify({ owner: { pid: ownerPid, start: ownerStart, boot: ownerBoot }, children: rows }));
}

describe("a long-lived child", () => {
  test("is gone once the parent that tracked it exits", async () => {
    const d = scratch();
    const script = `
      const { trackChild } = await import(${JSON.stringify(childLedgerModule)});
      const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      trackChild(p, "sleep");
      console.log(String(p.pid));
      process.exit(0);
    `;
    const parent = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, AGENTGLASS_STATE_DIR: d, XDG_STATE_HOME: join(d, "xdg"), AGENTGLASS_DB: join(d, "agentglass.db"), TMUX_TMPDIR: join(d, "tmux") },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const pid = Number((await new Response(parent.stdout).text()).trim());
    await parent.exited;
    expect(pid).toBeGreaterThan(0);
    try {
      expect(await gone(pid)).toBe(true);
    } finally {
      stopped(pid);
    }
  });

  test("whose pid now belongs to another process is not killed by the reap", async () => {
    const d = scratch();
    const dead = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const other = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      // The owner is a process that has already exited.
      dead.kill();
      await dead.exited;
      const file = join(d, `children.${dead.pid}.json`);
      // Same pid, a start time that was never this process's.
      writeLedgerFile(file, dead.pid, "0", [{ pid: other.pid, start: "0", cmd: "udisksctl monitor" }]);
      expect(reapRecordedChildren(d)).toBe(0);
      await Bun.sleep(100);
      expect(alive(other.pid)).toBe(true);

      // The record this process would really have written does stop it, and
      // the dead owner's file goes with it.
      writeLedgerFile(file, dead.pid, "0", [{ pid: other.pid, start: startStamp(other.pid), cmd: "udisksctl monitor" }]);
      expect(reapRecordedChildren(d)).toBe(1);
      expect(await gone(other.pid)).toBe(true);
      // The file outlives the SIGTERM on purpose: a server that exits inside
      // the grace window leaves it for the next boot rather than lose the pid.
      const cleared = Date.now() + STOP_GRACE_MS + 2_000;
      while (existsSync(file) && Date.now() < cleared) await Bun.sleep(25);
      expect(existsSync(file)).toBe(false);
    } finally {
      stopped(other.pid);
    }
  });

  test("of a running owner is left alone by another server's boot reap", async () => {
    // The failing case this closes: the desktop app is running, `make check`
    // boots a second server on the same state dir, and that server's reap used
    // to stop the app's live monitors and delete their ledger.
    const d = scratch();
    const ownerProc = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const live = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const ownerStart = startStamp(ownerProc.pid);
      expect(ownerStart).not.toBe("");
      const file = join(d, `children.${ownerProc.pid}.json`);
      writeLedgerFile(file, ownerProc.pid, ownerStart, [{ pid: live.pid, start: startStamp(live.pid), cmd: "udisksctl monitor" }]);

      // The reap the second server runs at boot, from a separate process with
      // the same state directory.
      const boot = Bun.spawn([process.execPath, "-e",
        `const m = await import(${JSON.stringify(childLedgerModule)}); console.log(String(m.reapRecordedChildren(${JSON.stringify(d)})));`,
      ], { env: { ...process.env, AGENTGLASS_STATE_DIR: d }, stdout: "pipe", stderr: "pipe" });
      expect(Number((await new Response(boot.stdout).text()).trim())).toBe(0);
      await boot.exited;

      await Bun.sleep(200);
      expect(alive(live.pid), "a boot reap stopped a running server's live child").toBe(true);
      expect(existsSync(file), "a boot reap deleted a running server's ledger").toBe(true);
    } finally {
      stopped(live.pid);
      stopped(ownerProc.pid);
    }
  });

  test("the recorded start time is that process's own, not a constant field", async () => {
    // A wrong /proc field (say `itrealvalue`, 0 for nearly everything) would
    // make every pid match every record, and a test that only compares the
    // record against the same function would stay green.
    const first = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let second: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const a = startStamp(first.pid);
      expect(a).not.toBe("");
      expect(startStamp(first.pid)).toBe(a);
      await Bun.sleep(1_100);
      second = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const b = startStamp(second.pid);
      expect(b).not.toBe("");
      expect(b, "the start time is a constant, so it cannot tell a reused pid from the same one").not.toBe(a);
      if (process.platform === "linux") expect(a).toBe(procStart(first.pid));
    } finally {
      stopped(first.pid);
      if (second) stopped(second.pid);
    }
  });

  test("is written to the owner's ledger with its start time and forgotten when it stops", async () => {
    const d = scratch();
    useStateDir(d);
    const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      trackChild(p, "sleep");
      const file = ledgerFile();
      const ledger = JSON.parse(readFileSync(file, "utf8")) as { owner: { pid: number; start: string }; children: { pid: number; start: string }[] };
      expect(ledger.owner.pid).toBe(process.pid);
      expect(ledger.owner.start).toBe(startStamp(process.pid));
      expect(ledger.children.map((r) => r.pid)).toContain(p.pid);
      expect(ledger.children.find((r) => r.pid === p.pid)!.start).toBe(startStamp(p.pid));
      stopChild(p.pid);
      // The record outlives the SIGTERM: only the child's own exit forgets it.
      expect(await gone(p.pid)).toBe(true);
      const end = Date.now() + 2_000;
      while (existsSync(file) && Date.now() < end) await Bun.sleep(25);
      expect(existsSync(file)).toBe(false);
    } finally {
      stopped(p.pid);
    }
  });

  test("a ledger written before the state dir moved is still updated where it was written", async () => {
    // The URL the exit hook uses must be the one taken at track time; re-reading
    // AGENTGLASS_STATE_DIR at exit would let a failing test delete the
    // developer's real ledger.
    const first = scratch();
    const second = scratch();
    useStateDir(first);
    const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      trackChild(p, "sleep");
      const file = ledgerFile();
      expect(readFileSync(file, "utf8")).toContain(String(p.pid));
      useStateDir(second);
      stopChild(p.pid);
      const end = Date.now() + 2_000;
      while (existsSync(file) && Date.now() < end) await Bun.sleep(25);
      expect(existsSync(file), "the exit hook wrote to the directory the environment named later").toBe(false);
      expect(readdirSync(second).filter((n) => n.startsWith("children."))).toEqual([]);
    } finally {
      stopped(p.pid);
    }
  });

  test("started by the volume watcher goes through the same ledger", async () => {
    const d = scratch();
    useStateDir(d);
    let pid = 0;
    const stop = watchDevices(() => {}, () => {
      const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      pid = p.pid;
      return p;
    }, 20, "fake monitor");
    try {
      const end = Date.now() + 3_000;
      while (!pid && Date.now() < end) await Bun.sleep(25);
      expect(pid).toBeGreaterThan(0);
      const rows = JSON.parse(readFileSync(ledgerFile(), "utf8")) as { children: { pid: number }[] };
      expect(rows.children.map((r) => r.pid)).toContain(pid);
      stop();
      expect(await gone(pid)).toBe(true);
    } finally {
      stop();
      stopped(pid);
    }
  });
});

describe("a child that ignores SIGTERM", () => {
  test("is still killed when the server exits inside the grace window", async () => {
    // The record used to be dropped the moment stopChild signalled, and the
    // only cover was an unref'd timer: a server that exited within the grace
    // window took the knowledge with it.
    const d = scratch();
    const ready = join(d, "handler-installed");
    const script = `
      const { trackChild, stopChild } = await import(${JSON.stringify(childLedgerModule)});
      const p = Bun.spawn(["python3", "-c", "import os, signal, pathlib, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(os.environ['READY']).write_text('1'); time.sleep(300)"], { env: { ...process.env, READY: ${JSON.stringify(ready)} }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      trackChild(p, "ignores-sigterm");
      while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(10);
      stopChild(p.pid);
      console.log(String(p.pid));
      process.exit(0);
    `;
    const parent = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, AGENTGLASS_STATE_DIR: d, XDG_STATE_HOME: join(d, "xdg"), AGENTGLASS_DB: join(d, "agentglass.db"), TMUX_TMPDIR: join(d, "tmux") },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const pid = Number((await new Response(parent.stdout).text()).trim());
    await parent.exited;
    expect(pid).toBeGreaterThan(0);
    try {
      expect(await gone(pid)).toBe(true);
      // The exit hook's SIGKILL matched, and a queued one is not an exit: the
      // record outlives this process for the next boot, as the reap's does.
      const ledgers = readdirSync(d).filter((n) => n.startsWith("children."));
      expect(ledgers.length, "the exit hook deleted the record of a child whose SIGKILL was only queued").toBe(1);
      expect(readFileSync(join(d, ledgers[0]!), "utf8")).toContain(String(pid));
    } finally {
      stopped(pid);
    }
  }, 20_000);
});

/** Wait for a marker file a spawned process writes when it is ready. */
async function readyFile(file: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(file) && Date.now() < end) await Bun.sleep(10);
  expect(existsSync(file), `the fixture never wrote ${file}`).toBe(true);
}

/** A pid that has exited but whose parent has not waited for it. */
function procState(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
}

function deadPid() {
  const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.kill();
  return p;
}

describe("the boot the ledger records", () => {
  test("a record from another boot is dropped, never signalled", async () => {
    // The ledger outlives a reboot on purpose, and ticks-since-boot restart
    // from zero there: (pid, start) repeats across boots, so a record from the
    // previous one can name a stranger. This is that stranger, alive, with the
    // pair the old code would have matched.
    const d = scratch();
    const victim = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const dead = deadPid();
    await dead.exited;
    const file = join(d, `children.${dead.pid}.json`);
    writeLedgerFile(file, dead.pid, "0", [
      { pid: victim.pid, start: startStamp(victim.pid), boot: "00000000-0000-0000-0000-000000000000", cmd: "udisksctl monitor" },
    ]);
    try {
      expect(reapRecordedChildren(d)).toBe(0);
      await Bun.sleep(150);
      expect(alive(victim.pid), "a record from before the reboot stopped a stranger").toBe(true);
    } finally {
      stopped(victim.pid);
    }
  });

  test("an owner recorded on another boot is not this process, even with this pid", async () => {
    // The mirror image, and the server stopping itself at boot: the file names
    // our pid, from a boot that is over. It must be reaped, not skipped.
    const d = scratch();
    const file = join(d, `children.${process.pid}.json`);
    writeLedgerFile(file, process.pid, startStamp(process.pid), [], "00000000-0000-0000-0000-000000000000");
    expect(reapRecordedChildren(d)).toBe(0);
    expect(existsSync(file), "a ledger from a previous boot was left as if its owner were still running").toBe(false);
  });

  test("names the host and the boot in the file, so two hosts and two boots never share one", () => {
    // Two servers in separate pid namespaces on one bind-mounted state dir both
    // wrote `children.1.json`; so did two boots of the same pid.
    const d = scratch();
    useStateDir(d);
    const boot = bootId();
    expect(boot, "this host reports no boot id, so this test would prove nothing").not.toBe("");
    const file = ledgerFile();
    expect(file).toContain(boot);
    expect(file.endsWith(`.${process.pid}.json`)).toBe(true);
    expect(file, "the ledger name is still one per pid, not one per host, boot and pid").not.toBe(join(d, `children.${process.pid}.json`));
  });
});

describe("the file left behind by the reap", () => {
  test("is not deleted while the SIGKILL has only been queued", async () => {
    // A child in D state takes the signal and stays until its syscall returns.
    // Removing the file then leaves nothing to find it by at the next boot.
    const d = scratch();
    const ready = join(d, "handler-installed");
    const stubborn = Bun.spawn(
      ["python3", "-c",
        "import os, signal, pathlib, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(os.environ['READY']).write_text('1'); time.sleep(300)"],
      { env: { ...process.env, READY: ready }, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const dead = deadPid();
    await dead.exited;
    const file = join(d, `children.${dead.pid}.json`);
    writeLedgerFile(file, dead.pid, "0", [{ pid: stubborn.pid, start: startStamp(stubborn.pid), cmd: "gio" }]);
    try {
      await readyFile(ready);
      expect(reapRecordedChildren(d)).toBe(1);
      // The SIGKILL lands inside the grace timer's finish(); once the child is
      // gone, the file must still be there.
      expect(await gone(stubborn.pid, 10_000)).toBe(true);
      await Bun.sleep(250);
      expect(existsSync(file), "the ledger went while the SIGKILL was still only queued").toBe(true);
      // The next boot finds no process carrying that pid any more, and only
      // then is the file finished with.
      expect(reapRecordedChildren(d)).toBe(0);
      expect(existsSync(file)).toBe(false);
    } finally {
      stopped(stubborn.pid);
    }
  }, 20_000);

  test("is not deleted when another owner has written that path inside the grace window", async () => {
    // A crash leaves a dead owner's file and a child that takes the SIGTERM.
    // The pid is reused by a new server before the grace timer fires; its
    // ledger lives at the same path and used to be removed by name.
    const d = scratch();
    const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const dead = deadPid();
    await dead.exited;
    const file = join(d, `children.${dead.pid}.json`);
    writeLedgerFile(file, dead.pid, "0", [{ pid: child.pid, start: startStamp(child.pid), cmd: "sleep" }]);
    const rival = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      expect(reapRecordedChildren(d)).toBe(1);
      writeLedgerFile(file, rival.pid, startStamp(rival.pid), [{ pid: child.pid, start: "0", cmd: "its own child" }]);
      await Bun.sleep(STOP_GRACE_MS + 600);
      expect(existsSync(file), "the grace-window finish deleted a live owner's ledger").toBe(true);
      expect((JSON.parse(readFileSync(file, "utf8")) as { owner: { pid: number } }).owner.pid).toBe(rival.pid);
    } finally {
      stopped(child.pid);
      stopped(rival.pid);
    }
  }, 20_000);
});

describe("the owner of a ledger", () => {
  test("is alive when the kernel refuses us its pid, even with a start time that does not match", () => {
    // pid 1 belongs to another uid: kill(pid, 0) answers EPERM. Comparing start
    // times alone read that as dead and deleted the live owner's ledger.
    const d = scratch();
    const eperm = (() => {
      try { process.kill(1, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
    })();
    expect(eperm, "pid 1 is ours here (root), so the EPERM case cannot be built").toBe(true);
    const file = join(d, "children.1.json");
    writeLedgerFile(file, 1, "0", []);
    expect(reapRecordedChildren(d)).toBe(0);
    expect(existsSync(file), "a live owner's ledger was deleted because its stamp could not be compared").toBe(true);
  });

  test("is a zombie whose parent has not waited, and counts as gone", async () => {
    // The state is in /proc only, so this is the same Linux ceiling the module
    // documents: off Linux the zombie is invisible and the record waits a boot.
    if (process.platform !== "linux") return;
    const d = scratch();
    const ready = join(d, "zombie-pid");
    const parent = Bun.spawn(
      ["python3", "-c",
        "import os, pathlib, time\npid = os.fork()\nif pid == 0:\n    os._exit(0)\npathlib.Path(os.environ['READY']).write_text(str(pid))\ntime.sleep(300)\n"],
      { env: { ...process.env, READY: ready }, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
      await readyFile(ready);
      const zpid = Number(readFileSync(ready, "utf8"));
      const end = Date.now() + 3_000;
      while (procState(zpid) !== "Z" && Date.now() < end) await Bun.sleep(20);
      expect(procState(zpid)).toBe("Z");
      const file = join(d, `children.${zpid}.json`);
      writeLedgerFile(file, zpid, startStamp(zpid), []);
      expect(reapRecordedChildren(d)).toBe(0);
      expect(existsSync(file), "a zombie owner read as running, so its ledger waited another boot").toBe(false);
    } finally {
      parent.kill();
      await parent.exited;
    }
  });
});
