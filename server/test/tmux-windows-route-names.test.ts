/*
 * `/terminal/tmux/windows` did nothing for a write, and refused every session
 * a person had named.
 *
 * Two faults, one route, both found by pressing Rename on the phone. The read
 * branch had no method check, so a POST fell into it, found no `session` in
 * the query string and answered "invalid session" before the write branch
 * below it was ever reached.
 *
 * Behind it, the route checked the session with `validPaneName`, the shape of
 * the UUID-named sessions the chat panes are given (eight characters at
 * least), so `orbit` would have been "invalid session" for rename, close and
 * split alike. Found from the phone, which has to address the sessions that are
 * already there. `validSessionName` is the rule for a name this app ADDRESSES
 * rather than made; this pins that the route uses it.
 */
import { describe, expect, it } from "bun:test";
import { validPaneName, validSessionName } from "../src/tmuxpane.ts";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const code = (s: string): string => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
const route = code(src.slice(
  src.indexOf('if (pathname === "/terminal/tmux/windows" && req.method === "GET") {'),
  src.indexOf('if (pathname === "/terminal/commands") {'),
));

describe("the window route's idea of a session name", () => {
  it("the two rules really differ on a name somebody typed", () => {
    expect(validPaneName("orbit")).toBe(false);
    expect(validSessionName("orbit")).toBe(true);
  });

  it("the read branch is for GET only, or it answers a write first", () => {
    expect(route).toContain('"/terminal/tmux/windows" && req.method === "GET"');
    expect(route).toContain('"/terminal/tmux/windows" && req.method === "POST"');
  });

  it("reads and writes both use the one that accepts it", () => {
    expect(route).toContain("validSessionName(name)");
    expect(route).not.toContain("validPaneName");
  });

  it("only a window that starts somewhere needs a directory", () => {
    // Closing one whose checkout was deleted must still work.
    expect(route).toContain('b.op === "new" || b.op === "split"');
    expect(route).toContain("starts && (");
  });

  it("a name that tmux would read as a window target is still refused", () => {
    expect(validSessionName("orbit:0")).toBe(false);
  });
});
