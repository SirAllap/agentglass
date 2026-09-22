/*
 * How the restore asks the machine about processes, on a Mac and on Linux.
 *
 * The Linux spelling is measured and exact: `/proc/<pid>/cmdline` for an argv
 * (NUL-separated, so a value with a space survives), the kernel's own
 * children list where it exists and `ps -o pid= --ppid` where it does not.
 * The Mac one exists because the Linux one is not merely different there, it
 * is absent — `ps --ppid` is GNU, there is no /proc — so every pane restored
 * as a plain shell on a Mac until the seam was stated. The suite runs on
 * Linux and states a Mac through `ProcReader`.
 *
 * What the walk is for: the agent under a pane, with its argv — the pane's
 * own process first, because a window born from `exec claude …` has no shell
 * left in it and the agent IS that process.
 */
import { describe, expect, test } from "bun:test";
import { childPidsOf, argvOf, agentUnder, resumeIdIn, withoutPromptFlags, isBareShell, type ProcReader } from "../src/tmuxrestore.ts";

const RESUME = "0f6b6a1c-2d3e-4f50-8a9b-0c1d2e3f4a5b";

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
    "ps -ww -o args= -p 4242": "-zsh\n",
    "pgrep -P 4242": "4300\n4301\n",
    "ps -ww -o args= -p 4300": "sleep 45\n",
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

  test("the agent is found under the shell by basename, flags intact, and its id is on its line", () => {
    const { proc, asked } = mac();
    const found = agentUnder(4242, proc);
    expect(found?.name).toBe("claude");
    expect(found?.argv[0]).toBe("/opt/homebrew/bin/claude");
    expect(found?.argv).toContain("--dangerously-skip-permissions");
    expect(resumeIdIn(found!.argv)).toBe(RESUME);
    /* The pane's own process first, then its children, each by one ps; a
       child that is not the agent is asked for its own children in turn. */
    expect(asked).toEqual([
      ["ps", "-ww", "-o", "args=", "-p", "4242"],
      ["pgrep", "-P", "4242"],
      ["ps", "-ww", "-o", "args=", "-p", "4300"],
      ["pgrep", "-P", "4300"],
      ["ps", "-ww", "-o", "args=", "-p", "4301"],
    ]);
    /* A Mac has no cheap answer for a process's directory, and says so. */
    expect(found?.cwd).toBe("");
  });

  test("a pane whose shell has no agent under it answers nothing, quietly", () => {
    const { proc } = machine("darwin", { "ps -ww -o args= -p 4242": "-zsh\n", "pgrep -P 4242": "", "ps -ww -o args= -p 4300": "" });
    expect(childPidsOf(4242, proc)).toEqual([]);
    expect(agentUnder(4242, proc)).toBeNull();
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
    },
    {
      "/proc/4242/cmdline": "-bash\0",
      "/proc/4300/cmdline": "sleep\x0045\x00",
      "/proc/4301/cmdline": `/usr/bin/claude\0--append-system-prompt\0be terse\0--resume\0${RESUME}\0`,
    });

  test("children come from ps -o pid= --ppid when the kernel does not list them", () => {
    const { proc, asked } = linux();
    expect(childPidsOf(4242, proc)).toEqual([4300, 4301]);
    expect(asked).toEqual([["ps", "-o", "pid=", "--ppid", "4242"]]);
  });

  test("and from /proc/<pid>/task/<pid>/children, one read and no process, when it does", () => {
    const { proc, asked } = machine("linux", {}, { "/proc/4242/task/4242/children": "4300 4301 " });
    expect(childPidsOf(4242, proc)).toEqual([4300, 4301]);
    expect(asked).toEqual([]);
  });

  test("argv comes from /proc/<pid>/cmdline, so a value with a space survives", () => {
    const { proc, asked } = linux();
    expect(argvOf(4301, proc)).toEqual(["/usr/bin/claude", "--append-system-prompt", "be terse", "--resume", RESUME]);
    expect(asked).toEqual([]); // no ps for the argv on Linux
  });

  test("the agent is found the same way, and the id lifted from its line", () => {
    const { proc } = linux();
    const found = agentUnder(4242, proc);
    expect(found?.argv[0]).toBe("/usr/bin/claude");
    expect(resumeIdIn(found!.argv)).toBe(RESUME);
  });

  test("a window born from `exec claude …` has no shell in it: the agent is the pane's own process", () => {
    /* Measured on the owner's desk: six windows opened by an orchestrator as
       `tmux new-window "exec claude …"` were photographed with no flags and
       no id, because the walk started at the pane process's CHILDREN and it
       had none — exec had replaced the shell. */
    const { proc, asked } = machine("linux", {}, {
      "/proc/4242/cmdline": "claude\0--model\0fable\0--dangerously-skip-permissions\0Read the brief and follow it.\0",
    });
    const found = agentUnder(4242, proc);
    expect(found?.name).toBe("claude");
    expect(found?.argv).toEqual(["claude", "--model", "fable", "--dangerously-skip-permissions", "Read the brief and follow it."]);
    expect(asked, "found at the root; nobody asked for children").toEqual([]);
  });

  test("a CLI that is a script run by node is known by its package, and its prompt flag is taken off", () => {
    const { proc } = machine("linux", {}, {
      "/proc/5000/cmdline": "node\0/usr/lib/node_modules/@qwen-code/qwen-code/scripts/cli-entry.js\0-m\0qwen3\0-p\0summarise the diff\0",
    });
    const found = agentUnder(5000, proc);
    expect(found?.name).toBe("qwen");
    expect(withoutPromptFlags("qwen", found!.argv))
      .toEqual(["node", "/usr/lib/node_modules/@qwen-code/qwen-code/scripts/cli-entry.js", "-m", "qwen3"]);
  });

  test("a prompt flag this file does not know stays, because the person chose it", () => {
    expect(withoutPromptFlags("codex", ["codex", "--model", "o3", "fix the tests"])).toEqual(["codex", "--model", "o3", "fix the tests"]);
    expect(withoutPromptFlags("opencode", ["opencode", "-s", "ses_1", "--prompt=go on", "--agent", "build"]))
      .toEqual(["opencode", "-s", "ses_1", "--agent", "build"]);
  });

  test("a login shell with nothing to run is not a command to bring back; a shell with -c is", () => {
    expect(isBareShell(["-bash"])).toBe(true);
    expect(isBareShell(["/usr/bin/fish", "-l"])).toBe(true);
    expect(isBareShell(["bash", "-c", "sleep 45 && echo done"])).toBe(false);
    expect(isBareShell(["lazygit"])).toBe(false);
  });

  test("the walk stops at a shell's depth, and at a ceiling of processes", () => {
    /* A pane running a build is a tree with hundreds of leaves; this runs
       every ten seconds and must not read them all. */
    const files: Record<string, string> = { "/proc/1/cmdline": "-bash\0" };
    for (let i = 1; i < 200; i++) { files[`/proc/${i}/task/${i}/children`] = `${i + 1}`; files[`/proc/${i + 1}/cmdline`] = "make\0"; }
    const { proc } = machine("linux", {}, files);
    expect(agentUnder(1, proc)).toBeNull();
  });
});
