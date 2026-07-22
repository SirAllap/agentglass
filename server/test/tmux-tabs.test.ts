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
import { parseWindows, parseFrame, socketFromArgv, runAction, sanitizeWindowName, prefixKeys, type TmuxTarget } from "../src/tmuxctl.ts";

describe("reading tmux's window list", () => {
  test("id, index, name, active flag and tmux's own marks", () => {
    const out = "@0\t1\tAI01\t0\t-\n@4\t2\tlazygit\t1\t*\n";
    expect(parseWindows(out)).toEqual([
      { id: "@0", index: 1, name: "AI01", active: false, flags: "-" },
      { id: "@4", index: 2, name: "lazygit", active: true, flags: "*" },
    ]);
  });

  test("names with spaces survive", () => {
    // The reason the format is tab-separated. A space-separated one turns this
    // single window into three, and the tab strip grows phantom tabs.
    const [w] = parseWindows("@2\t3\tnpm run dev\t1\t*\n");
    expect(w!.name).toBe("npm run dev");
    expect(w!.index).toBe(3);
  });

  test("a window with no name is not dropped", () => {
    const [w] = parseWindows("@7\t4\t\t0\t\n");
    expect(w).toEqual({ id: "@7", index: 4, name: "", active: false, flags: "" });
  });

  test("blank lines and unparseable indexes are skipped, not guessed at", () => {
    expect(parseWindows("\n\n")).toEqual([]);
    expect(parseWindows("no such session: =agx\n")).toEqual([]);
    expect(parseWindows("@0\t1\tok\t1\t*\ngarbage\n")).toHaveLength(1);
    // A line without a window id is not a window, whatever else it looks like.
    expect(parseWindows("1\tok\t1\t*\n")).toEqual([]);
  });

  test("bell and activity marks are passed through for the panel to interpret", () => {
    const [bell, activity] = parseWindows("@0\t1\tbuild\t0\t!\n@1\t2\ttest\t0\t#\n");
    expect(bell!.flags).toBe("!");
    expect(activity!.flags).toBe("#");
  });
});

describe("which session the client is on", () => {
  // Read fresh every poll rather than once at attach, because a client outlives
  // the session it shows. tmux-continuum's restore is the case that broke: it
  // attaches you to a scratch session, restores the saved ones, switches you
  // across and kills the scratch one — so a session resolved at attach time
  // names something that no longer exists, and the tab strip empties out while
  // tmux keeps drawing its own status line where our tabs should have been.
  const frame = [
    "c\t/dev/pts/3\tother\t$1",
    "c\t/dev/pts/0\tmain\t$2",
    "w\t$1\t@0\t1\tnot-ours\t1\t*",
    "w\t$2\t@3\t1\tAI01\t1\t*",
    "w\t$2\t@4\t2\tAI02\t0\t-",
  ].join("\n");

  test("our client's session, and only our session's windows", () => {
    const f = parseFrame(frame, "/dev/pts/0");
    expect(f!.session).toBe("main");
    expect(f!.id).toBe("$2");
    expect(f!.windows.map((w) => w.name)).toEqual(["AI01", "AI02"]);
  });

  test("windows are matched by session id, not by name", () => {
    // resurrect will happily restore a second session called `main`, and a
    // kill-window aimed at the wrong one of those is unrecoverable.
    const twoMains = "c\t/dev/pts/0\tmain\t$2\nw\t$9\t@1\t1\tmain\t1\t*\nw\t$2\t@2\t1\tours\t1\t*";
    expect(parseFrame(twoMains, "/dev/pts/0")!.windows.map((w) => w.name)).toEqual(["ours"]);
  });

  test("a session with no windows of its own reads as empty, not as somebody else's", () => {
    expect(parseFrame("c\t/dev/pts/0\tmain\t$2\nw\t$1\t@0\t1\tnot-ours\t1\t*", "/dev/pts/0")!.windows).toEqual([]);
  });

  test("no client on our terminal is no answer at all", () => {
    // Mid-attach, or the client detached between the /proc walk and the ask.
    // Answering with the first session in the list would put somebody else's
    // windows in the strip, and a click there kills somebody else's window.
    expect(parseFrame(frame, "/dev/pts/9")).toBeNull();
    expect(parseFrame("", "/dev/pts/0")).toBeNull();
  });

  test("window names with tabs in them do not smuggle a session id", () => {
    // The name is the last-but-two field and is not re-split, so this is a
    // window called what it says, in $2, and not one in $7.
    const f = parseFrame("c\t/dev/pts/0\tmain\t$2\nw\t$2\t@1\t1\tnpm run dev\t1\t*", "/dev/pts/0");
    expect(f!.windows).toEqual([{ id: "@1", index: 1, name: "npm run dev", active: true, flags: "*" }]);
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

  test("selecting or killing without a real window id is refused", () => {
    // Ids go on a command line, and the strip they came from is up to a poll
    // stale, so anything that is not `@` plus digits is not addressed at all.
    expect(runAction(t, "select")).toBe(false);
    expect(runAction(t, "kill")).toBe(false);
    expect(runAction(t, "select", "2")).toBe(false);          // an index, not an id
    expect(runAction(t, "select", "@1 ; kill-server")).toBe(false);
    expect(runAction(t, "kill", "@")).toBe(false);
    expect(runAction(t, "select", "$0")).toBe(false);          // a session, not a window
  });

  test("a rename with no usable name, or no window, is refused", () => {
    expect(runAction(t, "rename", "@1", "\u001b\u0007\u0000")).toBe(false); // nothing left after cleaning
    expect(runAction(t, "rename", "@1", "   ")).toBe(false);
    expect(runAction(t, "rename", "@1", "")).toBe(false);
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

describe("the prefix the panel advertises", () => {
  // The "tmux is listening" mark has to know which key that is. Hardcoding C-b
  // would light up for everyone except the people who rebound it, who are the
  // ones who use tmux enough to have missed the indicator in the first place.
  test("an unreachable server yields no prefix rather than a guessed one", () => {
    const t: TmuxTarget = { pid: 1, socket: ["-L", "nonexistent-agx-test"], session: "s", id: "$0" };
    expect(prefixKeys(t)).toEqual([]);
  });
});
