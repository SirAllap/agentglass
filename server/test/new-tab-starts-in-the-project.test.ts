/*
 * A new tab opens in the project on screen.
 *
 * Reported with two screenshots: the panel's chip said the repository was
 * `~/code/orbit`, the prompt in the tab that had just been opened said
 * `~/code/agentglass-work`, and the ask was not subtle — "SIEMPRE SIEMPRE
 * SIEMPRE debe abrirse desde la raíz del proyecto seleccionado".
 *
 * `new-window` with no `-c` starts in the SESSION's directory, and the session
 * was created by the server, so its directory is wherever the server was
 * launched from. On a desktop build that is agentglass's own install checkout —
 * which is why the wrong path was always the same wrong path, and why it looked
 * like the app was ignoring the repository rather than answering a different
 * question.
 *
 * Held on the command rather than on a running tmux: what broke is one missing
 * argument, and a server here would prove tmux honours `-c`, which is not in
 * doubt.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the + on the tab strip", () => {
  it("starts the window somewhere, when it was told where", () => {
    const ctl = read("server/src/tmuxctl.ts");
    expect(ctl).toContain('return tmux(t.socket, ["new-window", "-t", t.id, ...(cwd ? ["-c", cwd] : [])]) !== null;');
  });

  it("checks the path before it becomes an argument", () => {
    /* It arrives from a browser, so: a string, an existing directory, and
       inside the workspace — the same envelope the agent and issue frames pass
       through. Anything else means no `-c`, which is tmux's own behaviour and
       not a guessed home directory. */
    const term = read("server/src/terminal.ts");
    expect(term).toContain('const wanted = typeof msg.root === "string" ? msg.root : "";');
    expect(term).toContain("existsSync(wanted) && inScope(repoRootOf(wanted) ?? wanted)");
    expect(term).toContain("msg.after === true, startIn)");
  });

  it("is sent the project the panel is showing", () => {
    // The panel is the only thing that knows which repository is selected; the
    // server can only see where a pane happens to be.
    const panel = read("web/src/components/TerminalPanel.tsx");
    expect(panel).toContain('tmuxCmd({ cmd: "new", root })');
  });

  it("carries the path on the frame both ends read", () => {
    const types = read("shared/types.ts");
    expect(types).toContain("root?: string };");
  });
});
