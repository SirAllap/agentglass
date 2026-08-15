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

describe("a saved config reaching the server that is already running", () => {
  const pane = Bun.file(new URL("../src/tmuxpane.ts", import.meta.url));
  const routes = Bun.file(new URL("../src/index.ts", import.meta.url));

  it("re-sources the generated conf rather than asking for a restart", async () => {
    /*
     * tmux reads its config when the SERVER starts. Saving a prefix therefore
     * did nothing until the engine was restarted — and restarting it takes
     * every pane on it, which on a machine using the engine for its terminal is
     * the whole desk. `source-file` applies it in place: `set -g`, `bind` and
     * `unbind` are idempotent, so the key changes and the sessions do not move.
     */
    expect(await pane.text()).toContain('const r = await tmux(["source-file", confPath()]);');
  });

  it("does it for both the prefix and the override, and says which happened", async () => {
    const text = await routes.text();
    expect(text).toContain("appliedNow = await reloadEngineConf();");
    expect(text).toContain("const appliedNow = applied.ok ? await reloadEngineConf() : false;");
    // The UI tells the two apart — "live, in the panes already open" against
    // "when the engine next starts" — so the answer is never a guess.
    expect(text).toContain("{ ...w, appliedNow }");
  });
});

describe("the labels that say which key to press", () => {
  const src = Bun.file(new URL("../src/terminal.ts", import.meta.url));

  it("re-read the prefix instead of remembering the one from the attach", async () => {
    /*
     * It was captured once, when tmux was first noticed, so the tab strip and
     * the hint bar drew that key for the life of the shell. Change it in the
     * panel — where it now reaches the running server — and every label still
     * said the old one. That reads exactly like a setting that did nothing,
     * and was reported as "I have to restart agentglass anyway".
     */
    const text = await src.text();
    expect(text).toContain("if (session.tmux) session.tmuxPrefix = prefixKeys(session.tmux);");
    // …and it counts as a change, or the sweep would read it and say nothing.
    expect(text).toContain("session.onEngine === true, session.tmuxPrefix ?? []]);");
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
