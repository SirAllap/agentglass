/*
 * Which tmux a terminal opens on.
 *
 * The engine had been built — its own binary, its own config, a prefix, a
 * restore — and nothing a person actually used ever reached it: the Terminal
 * view resumed the tmux on the machine, and the engine only ever saw a pane
 * when a chat sent a message. Measured on a real one, after a full day of use:
 *
 *   tmux -L agentglass ls  →  no server running
 *
 * So the view can be pointed at it, and the naming and the fallbacks are what
 * decide whether that is safe.
 */
import { describe, expect, it } from "bun:test";
import { engineSessionName } from "../src/tmuxpane.ts";
import { wantsDeskResume } from "../src/terminal.ts";

describe("naming an engine session after its checkout", () => {
  it("is the directory's own name, so `tmux ls` reads like the rail", () => {
    expect(engineSessionName("/home/me/code/orbit")).toBe("orbit");
    expect(engineSessionName("/home/me/code/orbit/")).toBe("orbit");
  });

  it("replaces what tmux refuses rather than passing it on", () => {
    /* tmux rejects `.` and `:` in a session name and answers "bad session
       name", which says nothing about the character it minded — a worktree
       called `orbit.next` would have opened on an error instead of a shell. */
    expect(engineSessionName("/home/me/code/orbit.next")).toBe("orbit-next");
    expect(engineSessionName("/home/me/code/a:b")).toBe("a-b");
  });

  it("always answers something a session can be called", () => {
    expect(engineSessionName("/")).toBe("shell");
    expect(engineSessionName("")).toBe("shell");
    expect(engineSessionName("/home/me/…")).toBe("shell");
    expect(engineSessionName("/home/me/" + "x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("what the choice may never take over", () => {
  it("stands aside for the same four things the resume does", () => {
    /* The engine is offered for the case where somebody opened a terminal and
       said nothing else. A tapped pane, an agent's ticket, a file to read and a
       docked console that asked for a plain shell all still win — the choice is
       made from `wantsDeskResume`, so there is one list, not two that drift. */
    const nothing = { attach: false, agent: false, editor: false };
    expect(wantsDeskResume({}, nothing)).toBe(true);
    expect(wantsDeskResume({ pane: "%58" }, nothing)).toBe(false);
    expect(wantsDeskResume({ fresh: true }, nothing)).toBe(false);
    expect(wantsDeskResume({}, { ...nothing, agent: true })).toBe(false);
    expect(wantsDeskResume({}, { ...nothing, editor: true })).toBe(false);
  });
});

describe("the shape of the command", () => {
  const src = Bun.file(new URL("../src/tmuxpane.ts", import.meta.url));

  it("attaches or creates, on our socket, with our config", async () => {
    /*
     * `-A` so the second tab of a checkout lands in the session the first one
     * made rather than beside it; `-L`/`-f` because every command on this
     * server carries both — that pair is what keeps the user's ~/.tmux.conf,
     * and their tpm/continuum with it, out of our server.
     */
    const text = await src.text();
    expect(text).toContain('"-L", tmuxSocket(), "-f", confPath(), "new-session", "-A", "-s", engineSessionName(root), "-c", root');
  });

  it("answers null rather than a command that cannot run", async () => {
    // No tmux, or a config the gate has refused: the caller falls back to the
    // resume and then to a plain shell. A terminal that opens on "command not
    // found" is worse than one that opens somewhere unremarkable.
    const text = await src.text();
    expect(text).toContain("if (!bin) return null;");
    expect(text).toContain("if (!confHealth().ok) return null;");
  });
});
