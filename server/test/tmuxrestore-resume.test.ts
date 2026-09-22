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
 * And the id is not merely the fallback, it is the RULE: a pane that held a
 * conversation is resumed by its id whatever line it was born from. The line
 * used to win when there was one, and the line carried the prompt — a
 * finished session's brief ran itself again after a restart (2026-09-21).
 *
 * These read the source, because building the command for real needs a CLI on
 * the PATH, which a suite must not depend on. The behaviour itself is driven
 * in restore-resumes-the-conversation.test.ts.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/tmuxrestore.ts", import.meta.url)).text();
const fn = src.slice(src.indexOf("export function runArgs("), src.indexOf("\n}\n", src.indexOf("export function runArgs(")));

describe("what a restored pane is told to run", () => {
  it("leaves lazy mode a plain shell", () => {
    // The desk comes back and nothing starts talking to a model until somebody
    // asks it to. That is what "lazy" promises in the settings panel.
    expect(fn).toContain('if (mode !== "all" || !pane) return [];');
  });

  it("resumes the conversation first, with the pane's own flags, before any born-with line", () => {
    /*
     * The flags moved into this line on 2026-09-03 and the reason is the whole
     * of restore-keeps-the-flags.test.ts: this user starts every session with
     * `--dangerously-skip-permissions`, and a desk rebuilt without it behaves
     * differently pane by pane. They go BEFORE the id — the id is the one part
     * of this command line the file builds itself, and nothing captured may
     * displace it.
     */
    expect(fn).toContain('return [bin, ...(pane.agentArgs ?? []), "--resume", id];');
    const resume = fn.indexOf('"--resume"');
    const argv = fn.indexOf("pane.startArgv");
    const line = fn.indexOf('["sh", "-c", pane.startCommand]');
    expect(resume, "the conversation outranks the argv").toBeLessThan(argv);
    expect(argv, "and the argv outranks the string tmux quoted").toBeLessThan(line);
  });

  it("will not put anything but a conversation id on that command line", () => {
    /* The id reaches a process argv. It comes from our own hook or from a
       running process's arguments, and it is still checked: a UUID, or the pane
       comes back as a shell. */
    expect(fn).toContain("if (id && SESSION_ID_RE.test(id)) {");
    expect(src).toMatch(/const SESSION_ID_RE = \/\^\[0-9a-fA-F\]\{8\}-/);
  });

  it("passes an argv as argv, and only a photograph from before argv existed through a shell", () => {
    // `sh -c` appears once, for the captured string that old files still hold;
    // everything else is an argv array handed to tmux as it is.
    expect([...src.matchAll(/\["sh", "-c"/g)].length).toBe(1);
    expect(fn).toContain("if (pane.startArgv?.length) return [...pane.startArgv];");
  });
});

describe("where the id comes from", () => {
  it("prefers the note the pane hook wrote, when this agent's own hooks wrote it", () => {
    expect(src).toContain("const note = paneAgentNote(p.id);");
    expect(src).toContain("const noteFits = !!note && noteIsThisAgents(note, under, server);");
  });

  it("and reads the running process when there is no note yet", () => {
    /* The case this covers is a pane that was ITSELF restored: it starts as
       `claude --resume <id>`, so the id is in its argv before any hook has
       fired. Without it a restored desk would not survive a second reboot. */
    expect(src).toContain("const resumed = resumeIdIn(under.argv);");
    expect(src).toContain("|| resumed;");
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
     * What is running NOW is the actual question: the note is only read for a
     * pane with the CLI under it, and only when that CLI's own hooks wrote it
     * (`noteIsThisAgents`: written after the process was born, or in its
     * directory).
     */
    expect(src).toContain("if (under && under.name === claudeName()) {");
    expect(src).toContain("const noteFits = !!note && noteIsThisAgents(note, under, server);");
  });

  it("compares against the CLI's own basename, not a literal", () => {
    // A machine whose binary lives elsewhere or is named otherwise must not be
    // silently excluded from the one feature this is for.
    expect(src).toContain('const claudeName = (): string => (claudeCode.bin() || "claude").split("/").pop() || "claude";');
  });
});
