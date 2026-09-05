/**
 * Every tmux command the panel can send has somebody listening for it.
 *
 * A lock on a mistake this app has made four times. `shot --out`, `record`,
 * and `--page` were each declared in the shared type, sent by the panel, and
 * handled by nobody — and each was found by a person using the app, not by a
 * test. `forgetSession()` was the same bug from the other side: a function
 * nothing called, so ended sessions came back after every restart.
 *
 * A type is a promise. This checks somebody kept it.
 */
import { test, expect } from "bun:test";

const types = await Bun.file(new URL("../../shared/types.ts", import.meta.url)).text();
const handler = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const ctl = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();

test("every tmux cmd in the shared type is handled in the server", () => {
  const cmds = new Set<string>();
  for (const m of types.matchAll(/t: "tmux";\s*cmd:\s*([^;\n]+)/g)) {
    for (const q of m[1].matchAll(/"([a-z]+)"/g)) cmds.add(q[1]);
  }
  expect(cmds.size, "the tmux message union moved — find it and fix this test").toBeGreaterThan(10);

  /* Two shapes count as handled: its own branch, or a name on the window-action
     allow-list, which is one branch serving seven commands. */
  const handled = (c: string) =>
    handler.includes(`msg.cmd === "${c}"`) || /\[([^\]]*)\]\.includes\(action\)/.test(handler)
      && (handler.match(/\[([^\]]*)\]\.includes\(action\)/) as RegExpMatchArray)[1].includes(`"${c}"`);

  expect([...cmds].filter((c) => !handled(c)), "declared, sendable, nothing listens").toEqual([]);
});

test("the padlock is enforced by the server, not only drawn by the panel", () => {
  /* A padlock the UI greys out but the server ignores is a padlock painted on
     the door: any other caller of `killSessionByName` walks straight through. */
  const kill = ctl.slice(ctl.indexOf("export function killSessionByName"));
  expect(kill.slice(0, kill.indexOf("\n}")), "kill must consult the lock itself").toContain("isLocked(session)");
});
