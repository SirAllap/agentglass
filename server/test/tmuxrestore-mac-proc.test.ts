/*
 * Finding the agent under a pane, on a machine that has no /proc.
 *
 * The restore reads each pane's shell, finds the agent among its children and
 * lifts the `--resume <uuid>` out of that argv. Both steps were Linux-only in
 * their spelling: `ps --ppid` is a GNU procps flag BSD `ps` rejects, and
 * `/proc/<pid>/cmdline` does not exist on a Mac. So every pane there came back
 * as a login shell — the same symptom the first real restore had on Linux, for
 * a different reason.
 *
 * The suite runs on Linux, so the machine is stated through the ProcReader
 * seam: what each command prints, what each file holds, and the platform. Both
 * branches are driven, and the Linux one is asserted to be the measured
 * spelling it always was.
 */
import { describe, expect, test } from "bun:test";
import { childPidsOf, argvOf, agentArgvAmong, resumeIdUnder, type ProcReader } from "../src/tmuxrestore.ts";

const RESUME = "0f6b6a1c-2d3e-4f50-8a9b-0c1d2e3f4a5b";

/** A machine: every command answers from `answers`, every file from `files`,
 *  and the suite reads back which commands were asked. */
function machine(platform: string, answers: Record<string, string>, files: Record<string, string> = {}) {
  const asked: string[][] = [];
  const proc: ProcReader = {
    platform,
    run: (argv) => { asked.push(argv); return answers[argv.join(" ")] ?? ""; },
    read: (path) => { if (path in files) return files[path]!; throw new Error(`ENOENT ${path}`); },
  };
  return { proc, asked };
}

describe("on a Mac", () => {
  const mac = () => machine("darwin", {
    "pgrep -P 4242": "4300\n4301\n",
    "ps -ww -o args= -p 4300": "-zsh\n",
    "ps -ww -o args= -p 4301": `/opt/homebrew/bin/claude --dangerously-skip-permissions --resume ${RESUME}\n`,
  });

  test("children come from pgrep -P, never from the GNU-only ps --ppid", () => {
    const { proc, asked } = mac();
    expect(childPidsOf(4242, proc)).toEqual([4300, 4301]);
    expect(asked).toEqual([["pgrep", "-P", "4242"]]);
  });

  test("argv comes from ps -ww -o args=, and /proc is never opened", () => {
    const { proc } = mac();
    expect(argvOf(4301, proc)).toEqual(["/opt/homebrew/bin/claude", "--dangerously-skip-permissions", "--resume", RESUME]);
    // `read` throws for everything on this machine; the darwin branch must not
    // have asked it anything or this would have been [].
  });

  test("the agent is found by basename among the children, flags intact", () => {
    const { proc } = mac();
    const argv = agentArgvAmong(childPidsOf(4242, proc), "claude", proc);
    expect(argv[0]).toBe("/opt/homebrew/bin/claude");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  test("the resume id is lifted from the children's argv: pgrep first, then ps per child", () => {
    const { proc, asked } = mac();
    expect(resumeIdUnder(4242, proc)).toBe(RESUME);
    expect(asked).toEqual([
      ["pgrep", "-P", "4242"],
      ["ps", "-ww", "-o", "args=", "-p", "4300"],
      ["ps", "-ww", "-o", "args=", "-p", "4301"],
    ]);
  });

  test("a pane whose shell has no agent under it answers nothing, quietly", () => {
    const { proc } = machine("darwin", { "pgrep -P 4242": "", "ps -ww -o args= -p 4300": "" });
    expect(childPidsOf(4242, proc)).toEqual([]);
    expect(agentArgvAmong([4300], "claude", proc)).toEqual([]);
    expect(resumeIdUnder(4242, proc)).toBeUndefined();
  });

  test("the documented limitation: a value with a space in it comes back as two arguments", () => {
    // `ps -o args=` joins argv with spaces and quotes nothing, so this cannot be
    // undone. Named here so nobody adds a quote-aware split that invents
    // quoting ps never wrote.
    const { proc } = machine("darwin", { "ps -ww -o args= -p 7": "claude --append-system-prompt be terse\n" });
    expect(argvOf(7, proc)).toEqual(["claude", "--append-system-prompt", "be", "terse"]);
  });
});

describe("on Linux, the measured spelling is unchanged", () => {
  const linux = () => machine("linux",
    {
      "ps -o pid= --ppid 4242": " 4300\n 4301\n",
      "ps -o args= --ppid 4242": `-bash\n/usr/bin/claude --append-system-prompt be terse --resume ${RESUME}\n`,
    },
    {
      "/proc/4300/cmdline": "-bash\0",
      "/proc/4301/cmdline": `/usr/bin/claude\0--append-system-prompt\0be terse\0--resume\0${RESUME}\0`,
    });

  test("children come from ps -o pid= --ppid", () => {
    const { proc, asked } = linux();
    expect(childPidsOf(4242, proc)).toEqual([4300, 4301]);
    expect(asked).toEqual([["ps", "-o", "pid=", "--ppid", "4242"]]);
  });

  test("argv comes from /proc/<pid>/cmdline, so a value with a space survives", () => {
    const { proc, asked } = linux();
    expect(argvOf(4301, proc)).toEqual(["/usr/bin/claude", "--append-system-prompt", "be terse", "--resume", RESUME]);
    expect(asked).toEqual([]); // no ps for the argv on Linux
  });

  test("the agent is found the same way", () => {
    const { proc } = linux();
    expect(agentArgvAmong(childPidsOf(4242, proc), "claude", proc)[0]).toBe("/usr/bin/claude");
  });

  test("the resume id still comes from one ps -o args= --ppid, as measured", () => {
    const { proc, asked } = linux();
    expect(resumeIdUnder(4242, proc)).toBe(RESUME);
    expect(asked).toEqual([["ps", "-o", "args=", "--ppid", "4242"]]);
  });
});
