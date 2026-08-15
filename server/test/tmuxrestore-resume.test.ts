/*
 * Bringing an agent back, not just the window it was in.
 *
 * The first real restore gave back six windows of login shells. `startCommand`
 * is the only thing the capture had, and tmux reports one ONLY for a pane it
 * created with a command — measured:
 *
 *   pane created as a shell, then `claude` typed into it  →  start_command ""
 *   pane created with the command                          →  start_command set
 *
 * Which is most of a real desk: people type `claude`, they do not spawn panes
 * around it. The conversation id is the missing half, and the app already
 * records it per pane.
 *
 * The same two sources, in the same order, as tmux-assistant-resurrect on the
 * user's own tmux — a hook's note first, the `--resume` in the process's argv
 * second. Confirmed by reading that plugin after he asked why we were not doing
 * what his tmux does.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/tmuxrestore.ts", import.meta.url)).text();

describe("what a restored pane is told to run", () => {
  it("leaves lazy mode a plain shell", () => {
    // The desk comes back and nothing starts talking to a model until somebody
    // asks it to. That is what "lazy" promises in the settings panel.
    expect(src).toContain('if (mode !== "all" || !pane) return [];');
  });

  it("replays a captured command line verbatim when there is one", () => {
    // A pane the app itself created carries its whole invocation, resume flag
    // and permission mode included. Nothing to reconstruct.
    expect(src).toContain('if (pane.startCommand) return ["sh", "-c", pane.startCommand];');
  });

  it("falls back to resuming the conversation the pane was holding", () => {
    expect(src).toContain('return [bin, "--resume", id];');
  });

  it("will not put anything but a conversation id on that command line", () => {
    /* The id reaches a process argv. It comes from our own hook or from a
       running process's arguments, and it is still checked: a UUID, or the pane
       comes back as a shell. */
    expect(src).toContain("if (!id || !SESSION_ID_RE.test(id)) return [];");
    expect(src).toMatch(/const SESSION_ID_RE = \/\^\[0-9a-fA-F\]\{8\}-/);
  });

  it("passes it as argv rather than through a shell", () => {
    // `sh -c` appears once, for the captured command that is already a shell
    // line; the resume path builds an argv array.
    expect([...src.matchAll(/\["sh", "-c"/g)].length).toBe(1);
  });
});

describe("where the id comes from", () => {
  it("prefers the note the pane hook wrote", () => {
    expect(src).toContain("paneAgentNote(p.id)?.session_id");
  });

  it("and reads the running process when there is no note yet", () => {
    /* The case this covers is a pane that was ITSELF restored: it starts as
       `claude --resume <id>`, so the id is in its argv before any hook has
       fired. Without it a restored desk would not survive a second reboot. */
    expect(src).toContain("|| await resumeIdOf(name, w.id, p.id)");
    expect(src).toContain('"-o", "args=", "--ppid"');
  });

  it("is stored in the photograph, because the pane id dies with the server", () => {
    expect(src).toContain("agentSession?: string;");
  });
});

describe("a note that outlived its agent", () => {
  it("does not turn a plain shell into one", () => {
    /*
     * The note is written when a session starts and stays on the pane; pane ids
     * are reused, and somebody who quits `claude` and goes back to their prompt
     * still has one. Measured on a test desk: two plain shells were captured
     * carrying conversation ids, and in "all" mode both would have come back as
     * agents where their owner had left a shell.
     *
     * `pane_current_command` answers what is running NOW, which is the actual
     * question.
     */
    expect(src).toContain("const agentSession = looksLikeAgent(p.command)");
    expect(src).toContain("function looksLikeAgent(command: string | undefined): boolean {");
  });

  it("compares against the CLI's own basename, not a literal", () => {
    // A machine whose binary lives elsewhere or is named otherwise must not be
    // silently excluded from the one feature this is for.
    expect(src).toContain('const bin = (claudeCode.bin() || "claude").split("/").pop() || "claude";');
  });
});
