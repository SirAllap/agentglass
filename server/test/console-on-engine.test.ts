/*
 * The docked console runs on the engine, in the `console` window of the
 * checkout's one session.
 *
 * It used to be a plain PTY that died with the window, and beside it a button
 * that typed `tmux new-session -A -s …` into the shell to make it survive —
 * a BARE `tmux`, which is the machine's own server with the machine's own
 * config, borrowed to give an app shell a life of its own.
 *
 * Two things make that unnecessary: the engine already outlives the app, and it
 * is ours. The button is gone; the console is persistent by construction.
 *
 * What is worth locking is WHERE it lives, and the two halves of that are one
 * decision. The window is `console` on the checkout's session, because a
 * session of its own (`<checkout>-console`) is a tab the strip cannot show —
 * see tmux-one-session.test.ts. And the console's client joins a GROUP of that
 * session rather than the session itself: two clients on one session mirror
 * each other, keystroke for keystroke, which is a report this app already has.
 */
import { describe, expect, it } from "bun:test";
import { engineConsoleArgv, engineAttachArgv, engineSessionName, CONSOLE_WINDOW } from "../src/tmuxpane.ts";

const terminal = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

describe("the console's place on the engine", () => {
  it("is a window of the terminal's session, not a session of its own", () => {
    const desk = engineAttachArgv("/home/someone/code/shop-api");
    const con = engineConsoleArgv("/home/someone/code/shop-api", "@4");
    if (!desk || !con) return; // no tmux on this machine — nothing to compare
    expect(con).not.toEqual(desk);
    const engine = engineSessionName("/home/someone/code/shop-api");
    // Grouped on the engine's session: the same windows, its own current one.
    const at = con.indexOf("new-session");
    expect(at).toBeGreaterThan(0);
    expect(con.slice(at, at + 5)).toEqual(["new-session", "-d", "-t", `=${engine}`, "-s"]);
    // And the window it shows is the console's, by tmux's own id.
    expect(con.join(" ")).toContain(`select-window -t =${con[at + 5]}:@4`);
    expect(CONSOLE_WINDOW).toBe("console");
    // The old name is never in the argv, in either spelling.
    expect(con.join(" ")).not.toContain(`${engine}-console`);
    expect(con.join(" ")).not.toContain(`${engine}-bench`);
  });

  it("keeps every other flag the terminal's attach uses", () => {
    /* Built from the other argv rather than repeated, so the socket, the config
       and the flags cannot drift apart — which is exactly how one of two paths
       ends up reading the user's ~/.tmux.conf. */
    const desk = engineAttachArgv("/home/someone/code/shop-api");
    const con = engineConsoleArgv("/home/someone/code/shop-api", "@4");
    if (!desk || !con) return;
    const head = desk.slice(0, desk.indexOf("new-session"));
    expect(con.slice(0, head.length)).toEqual(head);
    expect(con).toContain("-S");
    expect(con).toContain("-f");
  });

  it("answers null exactly when the terminal's attach does", () => {
    /* A terminal that opens on "command not found" is worse than one that opens
       somewhere unremarkable, so the caller falls back to a shell on null. The
       two must agree: one path finding tmux and the other not is a console that
       exists on some machines and not others for no reason a user can see. */
    for (const root of ["", "/home/someone/code/shop-api", "/tmp"]) {
      expect(engineConsoleArgv(root, "@4") === null, root).toBe(engineAttachArgv(root) === null);
    }
  });

  it("refuses a window id that is not one", () => {
    for (const bad of ["", "@", "4", "; rm -rf /", "@1; kill-server"]) {
      expect(engineConsoleArgv("/home/someone/code/shop-api", bad), bad).toBeNull();
    }
  });
});

describe("how the server decides", () => {
  it("gives the console the engine whatever the terminal view is set to", () => {
    /* The setting is about YOUR terminal, where you may well want your own tmux
       and your own sessions. The console is the app's.
       The bench is asked first — it is the same rule one step further, a window
       of its own — and the console's branch is what is left. */
    expect(terminal).toContain("const window = d.bench ? benchWindowName(d.bench) : CONSOLE_WINDOW;");
    expect(terminal).toContain("return d.bench ? engineBenchArgv(startIn, d.bench, at.windowId) : engineConsoleArgv(startIn, at.windowId);");
  });

  it("makes the window before the view, so the work outlives the panel", () => {
    expect(terminal).toContain("const at = ensurePanelWindow(startIn, window, {");
  });

  it("still lets the terminal view choose", () => {
    expect(terminal).toContain('plain && tmuxTerminal() === "engine" ? plainEngineArgv(startIn) : null');
  });
});
