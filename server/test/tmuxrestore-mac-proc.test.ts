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
import { childPidsOf, argvOf, agentUnder, resumeIdIn, withoutPromptFlags, isBareShell, isForeground, startedAtOf, noteIsThisAgents, NOTE_SLACK_MS, type ProcReader } from "../src/tmuxrestore.ts";

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
    /* `-c` folded into other flags still runs the next argument. */
    expect(isBareShell(["bash", "-lc", "sleep 45"])).toBe(false);
    expect(isBareShell(["sh", "-ec", "sleep 45"])).toBe(false);
    expect(isBareShell(["lazygit"])).toBe(false);
  });

  test("a one-shot job of another CLI is nothing to bring back: it would run again at boot", () => {
    expect(withoutPromptFlags("codex", ["codex", "exec", "--full-auto", "fix the tests"])).toEqual([]);
    expect(withoutPromptFlags("opencode", ["opencode", "run", "summarise"])).toEqual([]);
    expect(withoutPromptFlags("opencode", ["opencode", "-s", "ses_1"])).toEqual(["opencode", "-s", "ses_1"]);
  });

  test("the agent has to be what the pane is running, not a worker something in it spawned", () => {
    /* A dev server that runs `claude -p` helpers is a `node` pane, and would
       otherwise come back as one helper's conversation. */
    expect(isForeground({ name: "claude", argv: ["/usr/bin/claude", "--model", "opus"], cwd: "" }, "claude")).toBe(true);
    expect(isForeground({ name: "claude", argv: ["/usr/bin/claude", "-p", "lint"], cwd: "" }, "node")).toBe(false);
    /* A launcher is the `node` tmux names, and so is its script. */
    expect(isForeground({ name: "qwen", argv: ["node", "/usr/bin/qwen"], cwd: "" }, "node")).toBe(true);
    expect(isForeground({ name: "opencode", argv: ["/opt/opencode/bin/opencode", "-s", "x"], cwd: "" }, "opencode")).toBe(true);
  });

  test("a process's start time is read off /proc, counted from the last `)` of a comm that may hold one itself", () => {
    /* btime 1 700 000 000 s; the process started 123 456 ticks (1 234.56 s)
       after boot. The comm `node (main)` has a space and a `)` in it. */
    const { proc } = machine("linux", {}, {
      "/proc/stat": "cpu  1 2 3 4\nbtime 1700000000\nprocesses 9\n",
      "/proc/77/stat": "77 (node (main)) S 1 77 77 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 123456 1000 200 18446744073709551615\n",
    });
    expect(startedAtOf(77, proc)).toBe(1_700_000_000_000 + 1_234_560);
    expect(startedAtOf(78, proc), "a process that is gone").toBe(0);
    const { proc: mac } = machine("darwin", {});
    expect(startedAtOf(77, mac), "a Mac cannot say").toBe(0);
  });

  test("a note is this agent's when it was written after the agent was born; the directory only has to match when the machine cannot say", () => {
    const born = 1_700_000_000_000;
    const here = { cwd: "/home/someone/code/orbit", startedAt: born };
    /* The hook's cwd follows `cd`; the process's does not. Same agent. */
    expect(noteIsThisAgents({ cwd: "/home/someone/code/orbit/server/src", at: born + 60_000 }, here)).toBe(true);
    expect(noteIsThisAgents({ cwd: "/tmp", at: born + 60_000 }, here), "a cd out of the repo is still this agent").toBe(true);
    /* Written before this process existed: the previous occupant of the id. */
    expect(noteIsThisAgents({ cwd: "/home/someone/code/acme", at: born - 60_000 }, here)).toBe(false);
    /* The boot time is whole seconds, so a note from the first moment is not set aside. */
    expect(noteIsThisAgents({ cwd: "/tmp", at: born - NOTE_SLACK_MS + 1 }, here)).toBe(true);
    /* Equal directories need no clock — even for a note older than the process. */
    expect(noteIsThisAgents({ cwd: "/home/someone/code/orbit", at: born - 60_000 }, here)).toBe(true);
    /* A Mac says neither, and the note is taken at its word; a machine that
       says the directory and not the time keeps the old rule. */
    expect(noteIsThisAgents({ cwd: "/elsewhere", at: 0 }, { cwd: "", startedAt: 0 })).toBe(true);
    expect(noteIsThisAgents({ cwd: "/elsewhere", at: born + 1 }, { cwd: "/home/someone/code/orbit", startedAt: 0 })).toBe(false);
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
