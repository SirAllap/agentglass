/*
 * A console docked inside another view is a shell of its own.
 *
 * It was not. The server resumes the tmux session the desk was last in for any
 * plain shell — right for the terminal view, right for the phone — and the
 * consoles had no way to opt out, so they attached to it as extra clients.
 * Measured while he was looking at it: three tmux clients, all on session
 * `orbit`, so the console under Docker's logs was showing whichever tab the
 * terminal view had selected, and a command typed into it would have gone to
 * the pane running an agent.
 *
 * The server side of the rule is in server/test/desk-resume.test.ts. This is
 * the other half: that the flag is actually sent, by both consoles.
 */
import { describe, expect, it } from "bun:test";
import { ptyWsUrl } from "../src/lib/api.ts";

const terminal = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();
const shellConsole = await Bun.file(new URL("../src/components/ShellConsole.tsx", import.meta.url)).text();

describe("the flag on the wire", () => {
  it("is absent unless it is asked for", () => {
    // The terminal view's own tabs, and the phone, still get the desk session.
    expect(ptyWsUrl("/home/me/code", 80, 24)).not.toContain("fresh");
  });

  it("says so plainly when it is", () => {
    expect(ptyWsUrl("/home/me/code", 80, 24, undefined, false, undefined, true)).toContain("&fresh=1");
    // And the console flag is its own, not implied by fresh.
    expect(ptyWsUrl("/home/me/code", 80, 24, undefined, false, undefined, true)).not.toContain("console=1");
    expect(ptyWsUrl("/home/me/code", 80, 24, undefined, false, undefined, true, true)).toContain("&console=1");
  });

  it("does not disturb the parameters it sits beside", () => {
    // `edit` only applies to a file, and `fresh` is not a file — a positional
    // list this long is exactly where an argument lands in the wrong slot.
    const url = ptyWsUrl("/home/me/code", 100, 30, "notes.md", true, undefined, true);
    expect(url).toContain("view=notes.md");
    expect(url).toContain("&edit=1");
    expect(url).toContain("&fresh=1");
  });
});

describe("who sends it", () => {
  it("the console docked under Docker's logs", () => {
    // Both places that claim a console session mark it, because either one can
    // be the first to create it: the strip mounting, and `runInConsole` being
    // called by a panel button before the strip is open.
    expect(terminal.match(/s\.console = true;/g)?.length).toBe(2);
    /* Two flags now, and they answer different questions: `fresh` says "not the
       session the desk resumed", and `console` says "this is the app's shell,
       and it must outlive the window" — which is what puts it on the engine. */
    expect(terminal).toContain("ptyWsUrl(s.root, s.term.cols, s.term.rows, undefined, false, ticket, s.console === true, s.console === true)");
  });

  it("the console that pre-types a command and waits for your Enter", () => {
    /* This one is the reason the bug was worth a same-day fix rather than a
       note: it types `apt-get install …` or a branch deletion into the shell
       and leaves the Enter to you. Into the desk's session, that is somebody
       else's pane. */
    expect(shellConsole).toContain("ptyWsUrl(cwd, term.cols, term.rows, undefined, false, undefined, true, true)");
  });
});
