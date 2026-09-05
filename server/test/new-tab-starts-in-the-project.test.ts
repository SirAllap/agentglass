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
    /* The `new` case, whatever else it grows. It has already grown once — the
       window is now named `AI0N` and pinned against tmux's automatic rename —
       and a lock that pinned the whole line broke on a change that had nothing
       to do with the directory. What must hold is that `-c cwd` is still on
       the command, and that its absence is still tmux's own behaviour rather
       than a guessed path. */
    const at = ctl.indexOf('case "new":');
    expect(at).toBeGreaterThan(0);
    const body = ctl.slice(at, ctl.indexOf('case "kill":', at));
    expect(body).toContain('"new-window"');
    expect(body).toContain('...(cwd ? ["-c", cwd] : [])');
  });

  it("checks the path before it becomes an argument", () => {
    /* It arrives from a browser, so: a string, an existing directory, and
       inside the workspace — the same envelope the agent and issue frames pass
       through. Anything else means no `-c`, which is tmux's own behaviour and
       not a guessed home directory. */
    const term = read("server/src/terminal.ts");
    expect(term).toContain('const wanted = typeof msg.root === "string" ? msg.root : "";');
    expect(term).toContain("existsSync(wanted) && inScope(repoRootOf(wanted) ?? wanted)");
    /* The validated path has to REACH the command. Asserted as a prefix rather
       than up to the closing paren: the call grew a client argument when the
       floating scratch turned out to swallow new tabs (see tmux-popup.test.ts),
       and a lock that breaks on every later argument is a lock people delete. */
    expect(term).toContain("msg.after === true, startIn");
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
