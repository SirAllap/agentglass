// Who started the thing that is holding this port?
//
// The question came from a real mess: four dev servers of mine were left
// running on the user's machine for hours, and every teardown I wrote reported
// success because it searched for the port in the process's command line — and
// the port is passed in the environment, so the listening process's cmdline is
// just `bun run src/index.ts`. Nothing found it, nothing killed it, and nothing
// said so.
//
// The panel already listed those ports. What it could not say was that a
// coding agent had started them and then gone away. These tests cover that
// signal and, deliberately, its limits: it reports WHO started a process, not
// whether the process deserves to die.
import { describe, expect, test } from "bun:test";
import { ageSecOf, parsePorts, startedByAgent, type ProcStep } from "../src/machine.ts";

/** A process tree written down, so the walk can be tested without one running. */
const tree = (t: Record<number, { cmdline: string; ppid: number }>): ProcStep =>
  (pid) => t[pid] ?? null;

const AGENT_SH = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-fish-1.fish && cd /repo";

describe("telling an agent's leftovers from everything else on the machine", () => {
  test("a dev server under an agent's tool-call shell is recognised", () => {
    // The real shape, measured: bun ← the tool-call shell ← systemd.
    expect(startedByAgent(100, tree({
      100: { cmdline: "bun run src/index.ts", ppid: 101 },
      101: { cmdline: AGENT_SH, ppid: 1 },
    }))).toBe(true);
  });

  test("it looks past a wrapper, because `setsid env …` puts one in the way", () => {
    expect(startedByAgent(100, tree({
      100: { cmdline: "bun run src/index.ts", ppid: 101 },
      101: { cmdline: "setsid env AGENTGLASS_PORT=4189 bun run src/index.ts", ppid: 102 },
      102: { cmdline: AGENT_SH, ppid: 1 },
    }))).toBe(true);
  });

  test("the app's own installed server is not flagged", () => {
    /**
     * The measurement this whole feature turned on, and it could have gone the
     * other way: agentglass gets relaunched FROM an agent's tool call during a
     * rebuild. If that left a mark, the panel would accuse the user's own app
     * of being a leak every time it was reinstalled. It does not — relaunching
     * detaches it to systemd, so the ancestry is the server, the Electron
     * shell, and init.
     */
    expect(startedByAgent(200, tree({
      200: { cmdline: "/home/u/.local/share/agentglass-desktop/resources/agentglass-server", ppid: 201 },
      201: { cmdline: "/home/u/.local/share/agentglass-desktop/agentglass", ppid: 1 },
    }))).toBe(false);
  });

  test("a process is never flagged by its own command line", () => {
    // Otherwise anything a session ever typed the path into would qualify —
    // including this test file's own process on the machine that wrote it.
    expect(startedByAgent(300, tree({
      300: { cmdline: `grep -r ${AGENT_SH}`, ppid: 1 },
    }))).toBe(false);
  });

  test("ordinary user daemons stay unflagged", () => {
    expect(startedByAgent(400, tree({
      400: { cmdline: "ulauncher", ppid: 401 },
      401: { cmdline: "/usr/lib/systemd/systemd --user", ppid: 1 },
    }))).toBe(false);
  });

  test("a fully detached process reports nothing rather than guessing", () => {
    /**
     * The signal's honest limit, pinned so nobody reads a false as "a human
     * started this". `setsid` reparents to init once the launching shell
     * exits, and the trail back to the agent goes with it — measured on a real
     * one, which came back false while a sibling that still had its shell came
     * back true. Age is what covers this case, not ancestry.
     */
    expect(startedByAgent(800, tree({
      800: { cmdline: "bun run src/index.ts", ppid: 801 },
      801: { cmdline: "/usr/lib/systemd/systemd --user", ppid: 1 },
    }))).toBe(false);
  });

  test("a broken tree cannot hang the poll", () => {
    // This runs on every refresh of the panel, so a wrong ppid must cost a
    // wrong answer, never a spin. Both bounds are checked: a cycle...
    expect(startedByAgent(1, tree({ 1: { cmdline: "init", ppid: 1 } }))).toBe(false);
    expect(startedByAgent(500, tree({
      500: { cmdline: "a", ppid: 501 },
      501: { cmdline: "b", ppid: 500 },
    }))).toBe(false);
    // ...and depth, with the mark placed deliberately out of reach.
    const deep: Record<number, { cmdline: string; ppid: number }> = {};
    for (let i = 0; i < 30; i++) deep[600 + i] = { cmdline: "wrapper", ppid: 601 + i };
    deep[630] = { cmdline: AGENT_SH, ppid: 1 };
    expect(startedByAgent(600, tree(deep))).toBe(false);
    // A missing process ends the walk rather than throwing.
    expect(startedByAgent(700, tree({ 700: { cmdline: "x", ppid: 701 } }))).toBe(false);
  });
});

describe("the age of a listener", () => {
  test("this process has one, and it is not in the future", () => {
    const age = ageSecOf(process.pid);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    // A test run that has been going for a day is a different bug.
    expect(age!).toBeLessThan(86_400);
  });

  test("a pid that does not exist is null, not zero", () => {
    // Zero would render as "up 0s", which reads as "just started" — the
    // opposite of "we could not tell".
    expect(ageSecOf(0x7ffffff0)).toBeNull();
  });
});

describe("the new columns survive rows we know nothing about", () => {
  test("a port owned by another user carries no claims", () => {
    // Real `ss -ltnpH` output for a root-owned listener: no users:(()) at all.
    const r = parsePorts(`LISTEN 0      4096         127.0.0.53%lo:53         0.0.0.0:*`);
    expect(r.ports).toHaveLength(1);
    const p = r.ports[0]!;
    expect(p.mine).toBe(false);
    // Not false-because-checked; false because we never look at other users'
    // processes at all. Same reason cwd stays null.
    expect(p.fromAgent).toBe(false);
    expect(p.ageSec).toBeNull();
    expect(p.cwdGone).toBe(false);
    expect(p.cwd).toBeNull();
  });
});
