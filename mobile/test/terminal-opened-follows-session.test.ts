/*
 * A window this screen opened is followed to its OWN session.
 *
 * Left unset, `open` stayed null forever whenever the new window landed
 * somewhere other than whichever session was already on screen — a phone's
 * mirror is grouped with a desk session that does not share the repo's name,
 * and the server's own fallback for an unattached press is the repo's
 * basename regardless. The strip's filter is `t.session === session`
 * (terminal.tsx), so the pane existed on the machine and the phone still
 * showed "Nothing open" over it.
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
  test("takes the session off the answer, not the one already on screen", () => {
    const body = between(screen, "const onOpened = useCallback(", "}, [load]);");
    expect(body).toContain("setSession(answer.session)");
    // After the pane is set, so a poll racing this cannot filter it back out
    // of the strip before the session it belongs to is the one being read.
    expect(body.indexOf("setActive(answer.pane)")).toBeLessThan(body.indexOf("setSession(answer.session)"));
  });

  test("the type carries a session, not just a pane", () => {
    expect(screen).toContain('answer: { pane: string; session: string } | { error: string }');
  });
});
