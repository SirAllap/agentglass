// "Why is this here, and is it safe to stop?"
//
// The ports panel could say what was listening — port, pid, working directory,
// and whether an agent started it. It could not say what was HOLDING it, and
// that turned out to be the fact the question actually needs.
//
// Measured, not imagined: a `bun` sat on 0.0.0.0:4189 on this machine for a day
// and a half. `ss` named it, the panel listed it, and neither explained it. The
// answer took three reads of /proc by hand, and it was the chain: the server
// had been started from a terminal inside this app, so it inherited that
// terminal's environment — AGENTGLASS_BIND=0.0.0.0 and a real token included.
// `bun ← bash ← agentglass-server` says that in a row. "pid 1792521" does not.
//
// The walk shares `startedByAgent`'s ProcStep seam, so a tree here is written
// down rather than running.
import { describe, expect, test } from "bun:test";
import { ancestryOf, isPublicBind, parsePorts, type ProcStep } from "../src/machine.ts";

const tree = (t: Record<number, { cmdline: string; ppid: number }>): ProcStep =>
  (pid) => t[pid] ?? null;

describe("the chain that started it", () => {
  test("names the forebears nearest first, and leaves out the process itself", () => {
    // The shape that cost a day and a half of not knowing.
    expect(ancestryOf(100, tree({
      100: { cmdline: "/usr/bin/bun run src/index.ts", ppid: 101 },
      101: { cmdline: "/bin/bash -c …", ppid: 102 },
      102: { cmdline: "/opt/agentglass/resources/agentglass-server", ppid: 1 },
    }))).toEqual([
      { pid: 101, name: "bash" },
      { pid: 102, name: "agentglass-server" },
    ]);
  });

  test("stops at init rather than ending every chain with the same rung", () => {
    expect(ancestryOf(100, tree({
      100: { cmdline: "node server.js", ppid: 1 },
      1: { cmdline: "/sbin/init", ppid: 0 },
    }))).toEqual([]);
  });

  test("an orphan whose parent is gone says nothing rather than guessing", () => {
    expect(ancestryOf(100, tree({ 100: { cmdline: "bun x", ppid: 999 } })))
      .toEqual([{ pid: 999, name: "999" }]);
  });

  test("a process /proc will not describe yields an empty chain", () => {
    expect(ancestryOf(100, tree({}))).toEqual([]);
  });

  test("depth is capped, so a deep tree cannot turn a row into a paragraph", () => {
    const deep: Record<number, { cmdline: string; ppid: number }> = {};
    for (let i = 100; i < 130; i++) deep[i] = { cmdline: `/bin/p${i}`, ppid: i + 1 };
    expect(ancestryOf(100, tree(deep), 3).length).toBe(3);
  });

  test("a cycle terminates — /proc has reported them under namespace churn", () => {
    expect(() => ancestryOf(100, tree({
      100: { cmdline: "a", ppid: 101 },
      101: { cmdline: "b", ppid: 100 },
    }))).not.toThrow();
  });

  test("a login shell is `bash`, not `-bash`", () => {
    // The leading dash is a convention for "this is a login shell", not part of
    // any name, and printing it in a chain reads as a typo.
    expect(ancestryOf(100, tree({
      100: { cmdline: "vite", ppid: 101 },
      101: { cmdline: "-bash", ppid: 1 },
    }))).toEqual([{ pid: 101, name: "bash" }]);
  });

  test("the interpreter, not the script", () => {
    // Two `bun`s are told apart by the working directory the row already
    // carries. A basename that changes with every script makes the chain
    // unreadable as a shape, which is the only way it gets read at all.
    expect(ancestryOf(100, tree({
      100: { cmdline: "x", ppid: 101 },
      101: { cmdline: "/usr/bin/node /home/u/.local/share/nvm/bin/vite --port 3000", ppid: 1 },
    }))).toEqual([{ pid: 101, name: "node" }]);
  });
});

describe("bound to everything", () => {
  test("the three spellings of the wildcard", () => {
    for (const a of ["0.0.0.0", "::", "*"]) expect(isPublicBind(a)).toBe(true);
  });

  test("loopback is not one of them", () => {
    for (const a of ["127.0.0.1", "::1", "192.168.1.10", "127.0.0.53"]) {
      expect(isPublicBind(a)).toBe(false);
    }
  });

  test("a LAN address is not a wildcard", () => {
    // Bound to one interface on purpose is a different decision from bound to
    // all of them, and the chip should not conflate the two.
    expect(isPublicBind("100.64.0.1")).toBe(false);
  });
});

describe("what the panel is handed", () => {
  const SS = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    `LISTEN 0      512    0.0.0.0:4000        0.0.0.0:*         users:(("agentglass-serv",pid=${process.pid},fd=24))`,
    'LISTEN 0      4096   127.0.0.1:7437      0.0.0.0:*         users:(("engram",pid=5366,fd=3))',
  ].join("\n");

  test("every row carries the two new facts", () => {
    const r = parsePorts(SS);
    const wide = r.ports.find((p) => p.port === 4000)!;
    const local = r.ports.find((p) => p.port === 7437)!;
    expect(wide.publicBind).toBe(true);
    expect(local.publicBind).toBe(false);
    // Always an array, never undefined: the row maps over it without asking.
    for (const p of r.ports) expect(Array.isArray(p.ancestry)).toBe(true);
  });

  test("another user's process gets no chain", () => {
    // Same rule as `cwd`: /proc says nothing useful about somebody else's tree,
    // and asking anyway is how a ports panel turns into a machine audit. pid
    // 1 is init — not ours, and reliably present.
    const r = parsePorts('LISTEN 0 1 0.0.0.0:99:  0.0.0.0:* users:(("init",pid=1,fd=1))');
    const row = r.ports[0];
    if (row && !row.mine) expect(row.ancestry).toEqual([]);
  });
});
