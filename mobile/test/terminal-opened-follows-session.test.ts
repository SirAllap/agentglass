/*
 * A window this screen opened is followed to wherever it landed.
 *
 * Left unset, `open` stayed null whenever the new window landed somewhere other
 * than whichever session was already on screen — a phone's mirror is grouped
 * with a desk session that does not share the repo's name, and the server's own
 * fallback for an unattached press is the repo's basename regardless. The strip
 * used to be filtered by a `session` the screen held, so the pane existed on
 * the machine and the phone still showed "Nothing open" over it.
 *
 * The screen holds no session now: `open` is found among EVERY window by its
 * pane id, and the strip is the project that window is in. So following it is
 * `setActive`, and the bridge for a pane the poll has not listed yet. What this
 * pins is that nobody puts a session filter back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `\`${from}\` is gone — this test is reading the wrong code`).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, `\`${to}\` no longer follows \`${from}\``).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("onOpened", () => {
  test("goes to the pane it was told about and bridges it, with no session to keep in step", () => {
    const body = between(screen, "const onOpened = useCallback(", "}, [load]);");
    expect(body).toContain("setActive(answer.pane)");
    expect(body).toContain("pendingOpen.current = { paneId: answer.pane, session: answer.session");
    expect(body).not.toContain("setSession");
  });

  test("`open` is found among every window, not among a session's", () => {
    const line = screen.split("\n").find((l) => l.includes("const open = all.find"));
    expect(line, "the `open` computation moved").toBeTruthy();
    expect(screen).not.toMatch(/t\.session === session\b/);
    expect(screen).not.toContain("setSession(");
  });

  test("the type carries a session, not just a pane", () => {
    expect(screen).toContain('answer: { pane: string; cwd: string; session: string } | { error: string }');
  });
});
