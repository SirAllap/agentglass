// The panel draws tmux's window list as its own tabs, so these are the parts
// where a wrong answer would be silent: a window list read badly still renders,
// it just renders somebody else's windows or the wrong names.
//
// The live half (resolving a client to a session, running select-window) is
// exercised against a real tmux server in the PR description rather than here,
// because a test that spawns tmux is a test that fails on a machine without it.
// What is unit-tested is everything that turns tmux's text into our shapes, and
// everything that decides whether a command is allowed to run at all.
import { describe, expect, test } from "bun:test";
import { parseWindows, socketFromArgv, runAction, sanitizeWindowName, type TmuxTarget } from "../src/tmuxctl.ts";

describe("reading tmux's window list", () => {
  test("index, name, active flag and tmux's own marks", () => {
    const out = "1\tAI01\t0\t-\n2\tlazygit\t1\t*\n";
    expect(parseWindows(out)).toEqual([
      { index: 1, name: "AI01", active: false, flags: "-" },
      { index: 2, name: "lazygit", active: true, flags: "*" },
    ]);
  });

  test("names with spaces survive", () => {
    // The reason the format is tab-separated. A space-separated one turns this
    // single window into three, and the tab strip grows phantom tabs.
    const [w] = parseWindows("3\tnpm run dev\t1\t*\n");
    expect(w!.name).toBe("npm run dev");
    expect(w!.index).toBe(3);
  });

  test("a window with no name is not dropped", () => {
    const [w] = parseWindows("4\t\t0\t\n");
    expect(w).toEqual({ index: 4, name: "", active: false, flags: "" });
  });

  test("blank lines and unparseable indexes are skipped, not guessed at", () => {
    expect(parseWindows("\n\n")).toEqual([]);
    expect(parseWindows("no such session: =agx\n")).toEqual([]);
    expect(parseWindows("1\tok\t1\t*\ngarbage\n")).toHaveLength(1);
  });

  test("bell and activity marks are passed through for the panel to interpret", () => {
    const [bell, activity] = parseWindows("1\tbuild\t0\t!\n2\ttest\t0\t#\n");
    expect(bell!.flags).toBe("!");
    expect(activity!.flags).toBe("#");
  });
});

describe("finding the right tmux server", () => {
  // Asking the default server about a session that lives on another socket gets
  // a confident answer about somebody else's windows, so this is read off the
  // client's own command line rather than assumed.
  test("-L and -S are carried over", () => {
    expect(socketFromArgv(["tmux", "-L", "work", "attach", "-t", "main"])).toEqual(["-L", "work"]);
    expect(socketFromArgv(["tmux", "-S", "/run/user/1000/tmux", "new"])).toEqual(["-S", "/run/user/1000/tmux"]);
  });

  test("the default socket is expressed as no flags at all", () => {
    expect(socketFromArgv(["tmux", "attach"])).toEqual([]);
    expect(socketFromArgv(["tmux"])).toEqual([]);
  });

  test("a trailing -S with nothing after it is not a socket", () => {
    expect(socketFromArgv(["tmux", "attach", "-S"])).toEqual([]);
  });
});

describe("what a tab strip is allowed to ask for", () => {
  // The terminal socket already carries a shell, so this cannot widen anything
  // — but it must not become a way to run arbitrary tmux commands either. Each
  // of these is refused before tmux is invoked at all.
  const t: TmuxTarget = { pid: 1, socket: ["-L", "nonexistent-agx-test"], session: "s", id: "$0" };

  test("an action outside the four is refused", () => {
    expect((runAction as unknown as (t: TmuxTarget, a: string) => boolean)(t, "kill-server")).toBe(false);
    expect((runAction as unknown as (t: TmuxTarget, a: string) => boolean)(t, "run-shell")).toBe(false);
  });

  test("selecting or killing without a window index is refused", () => {
    expect(runAction(t, "select")).toBe(false);
    expect(runAction(t, "kill")).toBe(false);
    expect(runAction(t, "select", 1.5)).toBe(false);
    expect(runAction(t, "select", NaN)).toBe(false);
  });

  test("a rename with no usable name, or no window, is refused", () => {
    expect(runAction(t, "rename", 1, "\u001b\u0007\u0000")).toBe(false); // nothing left after cleaning
    expect(runAction(t, "rename", 1, "   ")).toBe(false);
    expect(runAction(t, "rename", 1, "")).toBe(false);
    expect(runAction(t, "rename", undefined, "valid")).toBe(false);
  });
});

describe("window names", () => {
  // A name is echoed into a status line and a shell title, so an escape
  // sequence smuggled through it writes wherever it likes on the terminal.
  // Stripped rather than rejected: the printable part of "buil\u001b[2Jd" is
  // still what the user meant to call it.
  test("control characters are removed, the rest is kept", () => {
    expect(sanitizeWindowName("buil\u001b[2Jd")).toBe("buil[2Jd");
    expect(sanitizeWindowName("npm run dev")).toBe("npm run dev");
    expect(sanitizeWindowName("api\u0000")).toBe("api");
  });

  test("a name that is only control characters is not a name", () => {
    expect(sanitizeWindowName("\u001b\u0007")).toBeNull();
    expect(sanitizeWindowName("  ")).toBeNull();
    expect(sanitizeWindowName(42)).toBeNull();
  });

  test("absurdly long names are cut, not passed on", () => {
    expect(sanitizeWindowName("x".repeat(500))!.length).toBe(64);
  });
});
