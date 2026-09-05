/*
 * The docked console runs on the engine, in a session of its own.
 *
 * It used to be a plain PTY that died with the window, and beside it a button
 * that typed `tmux new-session -A -s …` into the shell to make it survive —
 * a BARE `tmux`, which is the machine's own server with the machine's own
 * config, borrowed to give an app shell a life of its own.
 *
 * Two things make that unnecessary: the engine already outlives the app, and it
 * is ours. The button is gone; the console is persistent by construction.
 *
 * The session name is the part worth locking. Sharing the terminal view's meant
 * two clients on one tmux session, which tmux answers by mirroring — the
 * console showed whatever the terminal showed, keystroke for keystroke, and the
 * two fought over the size. That was reported once already.
 */
import { describe, expect, it } from "bun:test";
import { engineConsoleArgv, engineAttachArgv, engineSessionName } from "../src/tmuxpane.ts";

const terminal = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

describe("the console's engine session", () => {
  it("is not the terminal view's session", () => {
    const desk = engineAttachArgv("/home/someone/code/shop-api");
    const con = engineConsoleArgv("/home/someone/code/shop-api");
    if (!desk || !con) return; // no tmux on this machine — nothing to compare
    expect(con).not.toEqual(desk);
    expect(con.join(" ")).toContain(`${engineSessionName("/home/someone/code/shop-api")}-console`);
  });

  it("keeps every other flag the terminal's attach uses", () => {
    /* Built from the other argv rather than repeated, so the socket, the config
       and the flags cannot drift apart — which is exactly how one of two paths
       ends up reading the user's ~/.tmux.conf. */
    const desk = engineAttachArgv("/home/someone/code/shop-api");
    const con = engineConsoleArgv("/home/someone/code/shop-api");
    if (!desk || !con) return;
    expect(con.length).toBe(desk.length);
    expect(con.filter((a, i) => a !== desk[i]).length).toBe(1);
    expect(con).toContain("-L");
    expect(con).toContain("-f");
    expect(con).toContain("-A");
  });

  it("answers null exactly when the terminal's attach does", () => {
    /* A terminal that opens on "command not found" is worse than one that opens
       somewhere unremarkable, so the caller falls back to a shell on null. The
       two must agree: one path finding tmux and the other not is a console that
       exists on some machines and not others for no reason a user can see. */
    for (const root of ["", "/home/someone/code/shop-api", "/tmp"]) {
      expect(engineConsoleArgv(root) === null, root).toBe(engineAttachArgv(root) === null);
    }
  });
});

describe("how the server decides", () => {
  it("gives the console the engine whatever the terminal view is set to", () => {
    /* The setting is about YOUR terminal, where you may well want your own tmux
       and your own sessions. The console is the app's.
       The bench is asked first — it is the same rule one step further, a tab
       with a session of its own — and the console's branch is what is left. */
    expect(terminal).toContain("d.console\n      ? engineConsoleArgv(startIn)");
  });

  it("still lets the terminal view choose", () => {
    expect(terminal).toContain('plain && tmuxTerminal() === "engine" ? engineAttachArgv(startIn) : null');
  });
});
