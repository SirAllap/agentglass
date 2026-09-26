/*
 * The phone's New window sheet always has a plain shell.
 *
 * With any agent CLI installed the sheet offered agents and nothing else, so a
 * person who wanted a prompt in the project could not have one. A shell is
 * `kind: "shell"` on the same `agent` command: no agent binary, no flag, the
 * same directory rules, and it is checked before the agent table because it is
 * not a row in it.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const mobile = await Bun.file(new URL("../../mobile/app/(tabs)/terminal.tsx", import.meta.url)).text();

describe("Shell window", () => {
  test("the server opens a window with no agent for kind shell", () => {
    const at = src.indexOf('if (msg.cmd === "agent") {');
    const body = src.slice(at, src.indexOf('if (msg.cmd === "selectpane")', at));
    expect(body).toContain('kind === "shell"');
    // A shell is not refused as "no such agent".
    expect(body.indexOf('kind === "shell"')).toBeLessThan(body.indexOf('"no such agent"'));
  });

  test("the sheet offers Shell whether or not agents are installed", () => {
    const sheet = mobile.slice(mobile.indexOf('title="New window"'));
    expect(sheet).toContain('label="Shell"');
    expect(sheet).toContain('openAgent("shell", false)');
    // Not inside the branch that only draws when nothing is installed.
    expect(sheet.indexOf('label="Shell"')).toBeLessThan(sheet.indexOf("agents.every"));
  });

  test("a refusal keeps the attach: the note is drawn over the pane, not instead of it", () => {
    const at = mobile.indexOf("const onOpened = useCallback(");
    const body = mobile.slice(at, mobile.indexOf("}, [load]);", at));
    const fail = body.slice(body.indexOf('if ("error" in answer)'), body.indexOf("wanted.current"));
    expect(fail).not.toContain("setActive(");
    expect(fail).toContain("setError(");
  });
});
