// The tab strip's tmux poll answers the same JSON, twenty times a minute per
// attached client, while nothing moves. It slows down once it has been quiet —
// and must come back to the fast rate on any change, and must not slow down
// before tmux is known (that is how "tmux appeared" is detected). There is no
// tmux in a unit test, so the rule is asserted against the source.
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const from = src.indexOf("const arm = () => {");
const body = src.slice(from, src.indexOf("\n  arm();", from));
const code = body.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

describe("tmux poll backoff", () => {
  test("is self-rescheduling, not a fixed interval", () => {
    expect(from).toBeGreaterThan(0);
    expect(code).toContain("setTimeout(");
    expect(code).not.toContain("setInterval(");
  });
  test("slows only on a session tmux is already known for", () => {
    expect(code).toMatch(/quiet >= QUIET_SWEEPS && \(session\.tmux \|\| session\.onEngine\) \? SLOW_MS : 500/);
  });
  test("any change puts it back to the fast rate", () => {
    expect(code).toMatch(/if \(sent !== seen\) \{ seen = sent; quiet = 0; \} else quiet\+\+;/);
  });
  test("stops re-arming once the session is closed", () => {
    expect(code).toContain("if (session.closed) return;");
  });
});
