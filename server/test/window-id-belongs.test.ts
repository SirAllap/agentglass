/*
 * A window id is checked against the server, not only against the syntax.
 *
 * `@7` is a well-formed window id on every tmux running on the machine, and it
 * names a different window on each of them. This app now talks to at least two:
 * yours, and the engine. An id that arrived from one and is spent on the other
 * names something real and wrong — and the verbs that reach it here are
 * `kill-window`, `rename-window`, `move-window` and `resize-window`.
 *
 * Not hypothetical. A stale id once resized a session somebody was working in.
 *
 * The rule these tests hold is which actions pay for the check: the ones that
 * CHANGE something. `select` landing on nothing is a no-op you would not
 * notice; `kill` landing on the wrong window is somebody's work.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();
const guard = src.slice(src.indexOf("function windowOnSocket"), src.indexOf("export function runAction"));
const action = src.slice(src.indexOf("export function runAction"), src.indexOf('case "select":'));

describe("before writing to a tmux server", () => {
  it("asks that server whether the window is one of its own", () => {
    expect(guard).toContain('tmux(socket, ["list-windows", "-a", "-F", "#{window_id}"])');
  });

  it("treats a server that cannot be asked as a no", () => {
    /* Refusing an action is recoverable; performing it on the wrong window is
       not. */
    expect(guard).toContain("if (out === null) return false;");
  });

  it("matches the whole id, not a prefix of it", () => {
    // `@1` is a prefix of `@12`, and a `kill` is a poor place to learn that.
    expect(guard).toContain("l.trim() === windowId");
  });

  it("charges the check to every action that changes something", () => {
    for (const verb of ["kill", "rename", "move", "fit", "takeover"]) {
      expect(action, verb).toContain(`action === "${verb}"`);
    }
  });

  it("does not charge it to the ones that change nothing", () => {
    /* `select` and `new` run on every click through a strip of tabs, and
       neither can damage a window it lands on by mistake. */
    expect(action).not.toContain('action === "select"');
    expect(action).not.toContain('action === "new"');
  });

  it("keeps the syntax check as well, since shape is not identity", () => {
    expect(action).toContain('WINDOW_ID.test(window ?? "")');
  });
});
