/*
 * Everything the APP starts, starts on the engine.
 *
 * Three buttons — review a pull request, work an issue, the phone's `+` — used
 * to open a window in whatever tmux the panel's shell happened to be running:
 * the user's own server, with the user's own config. Three things were wrong
 * with that, and the third is the one that had already cost real work:
 *
 *   - It only worked if you had typed `tmux` in that pane. Without a client to
 *     resolve out of /proc the buttons answered "this terminal has no tmux",
 *     so a feature's availability depended on something you did in a shell.
 *   - It put the app's windows among yours, where a `kill-window` or a
 *     `resize-window` meant for one of ours could reach one of yours. Pane and
 *     window ids are per-SERVER, and that ambiguity has shrunk a real session.
 *   - The engine already survives the app closing, which is what the user's
 *     tmux was being borrowed FOR.
 *
 * These are source checks rather than behaviour: what is being locked is WHICH
 * SOCKET a call lands on, and a test that opens a real window would prove the
 * window opened without proving where.
 */
import { describe, expect, it } from "bun:test";

const terminal = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const engine = await Bun.file(new URL("../src/tmuxpane.ts", import.meta.url)).text();

describe("where the app opens its windows", () => {
  it("no longer opens any of them on the user's tmux", () => {
    /* `newWindowRunning` is tmuxctl's, and tmuxctl talks to the socket it
       resolved out of a shell's /proc entry. Nothing the app starts may use
       it. */
    expect(terminal).not.toContain("newWindowRunning(");
  });

  it("opens them on the engine instead, all three of them", () => {
    // Review, issue, and the phone's plus.
    expect(terminal.match(/engineWindowRunning\(/g)?.length).toBe(4);
    expect(terminal).toContain("`pr-${number}`");
  });

  it("stops refusing when your shell is not inside tmux", () => {
    /* The refusal, and the constant behind it, are both gone: there is nothing
       left to refuse for. Checked on the identifier rather than on the words —
       the sentence survives in the comment that explains why it went, and a
       test that trips over its own explanation is a test people delete. */
    expect(terminal).not.toContain("NO_TMUX");
    expect(terminal).not.toMatch(/error: *NO_TMUX/);
  });

  it("keeps reading the user's tmux where reading is the point", () => {
    /* The phone's `+` still asks which project its pane is in, and drawing your
       window list as tabs is the whole reason tmuxctl exists. Reads are fine;
       it is the writes that were the problem. */
    expect(terminal).toContain("paneCwd(target.socket");
  });
});

describe("the engine's own window opener", () => {
  it("talks only to our socket, through the engine's own helper", () => {
    const fn = engine.slice(engine.indexOf("export async function engineWindowRunning"), engine.indexOf("export function engineWindowName"));
    expect(fn).toContain('await tmux(["has-session", "-t", `=${session}`])');
    expect(fn).toContain('await tmux(["new-session", "-d", "-s", session');
    expect(fn).toContain('"new-window", "-P", "-F"');
    // No socket argument anywhere: `tmux()` in this module always adds -L and -f.
    expect(fn).not.toContain("-L");
  });

  it("asks whether the session is there rather than using -A", () => {
    /* `new-session -A` is attach-or-create and reads as exactly what is wanted.
       It is not: on an existing session it tries to ATTACH, and from a server
       process with no terminal tmux answers "open terminal failed: not a
       terminal" and exits non-zero — so the first window opened and every one
       after it returned null. Measured, and held here by name so the flag that
       looks right cannot come back. */
    const fn = engine.slice(engine.indexOf("export async function engineWindowRunning"), engine.indexOf("export function engineWindowName"));
    expect(fn).not.toContain('"new-session", "-A"');
    expect(fn).toContain('"has-session"');
  });

  it("returns both ids or neither", () => {
    /* Half an answer is a string that goes on a command line. tmux printing
       something unrecognised is not a reason to pass it along. */
    const fn = engine.slice(engine.indexOf("export async function engineWindowRunning"));
    expect(fn).toContain('paneId.startsWith("%") && windowId.startsWith("@")');
  });

  it("strips a dot from a window name", async () => {
    // tmux reads a dot as a pane separator in a target, so a window named with
    // one cannot be selected by name afterwards.
    const { engineWindowName } = await import("../src/tmuxpane.ts");
    expect(engineWindowName("pr-17.2")).toBe("pr-17-2");
    expect(engineWindowName("ORBIT-1042")).toBe("ORBIT-1042");
    expect(engineWindowName("")).toBeNull();
    expect(engineWindowName(undefined)).toBeNull();
  });
});
