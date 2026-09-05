/*
 * The desktop fallback on a Mac.
 *
 * With no window open to show an alert, alerts.ts hands it to the desktop —
 * `notify-send` on Linux. A Mac has no notify-send, so the spawn threw ENOENT,
 * the one-line warning fired, and the alert was gone. It now runs `osascript
 * -e 'display notification …'` there, with the text as AppleScript string
 * literals rather than spliced in: the text is agent output, and `osascript -e`
 * runs whatever it is handed.
 *
 * Pure: the argv is built from the platform, which is a parameter because this
 * runs on Linux. Nothing is spawned — alerts.ts refuses to under NODE_ENV=test
 * anyway (see the IS_TEST guard), and the recording seam covers the delivery
 * rule in alerts-sink.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { appleScriptString, desktopNotifyArgv } from "../src/alerts.ts";

describe("appleScriptString", () => {
  test("wraps in double quotes and escapes the two characters AppleScript knows", () => {
    expect(appleScriptString("plain")).toBe('"plain"');
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""');
    expect(appleScriptString("C:\\path\\x")).toBe('"C:\\\\path\\\\x"');
    // Backslash before quote: both escaped, in an order that cannot re-open
    // the literal — `\"` in the input becomes `\\\"`, not `\\"`.
    expect(appleScriptString('a\\"b')).toBe('"a\\\\\\"b"');
  });

  test("a body trying to end the literal and run something stays a string", () => {
    const hostile = '" & (do shell script "id") & "';
    const lit = appleScriptString(hostile);
    // Every inner quote is escaped, so the only unescaped quotes are the two
    // this function added.
    const unescaped = lit.replace(/\\"/g, "").match(/"/g) ?? [];
    expect(unescaped).toHaveLength(2);
    expect(lit.startsWith('"')).toBe(true);
    expect(lit.endsWith('"')).toBe(true);
  });
});

describe("desktopNotifyArgv", () => {
  test("darwin: osascript, one -e, the text as literals, no urgency and no --", () => {
    const argv = desktopNotifyArgv("✋ Approval needed", 'app wants to run Bash: rm -rf "x"', 2, "darwin");
    expect(argv[0]).toBe("osascript");
    expect(argv[1]).toBe("-e");
    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe('display notification "app wants to run Bash: rm -rf \\"x\\"" with title "✋ Approval needed"');
    expect(argv).not.toContain("--");
    expect(argv).not.toContain("-u");
  });

  test("darwin: the title goes through the same escaping as the body", () => {
    const argv = desktopNotifyArgv('a "quoted" title', "b", 1, "darwin");
    expect(argv[2]).toContain('with title "a \\"quoted\\" title"');
  });

  test("linux: notify-send exactly as it was, urgency mapped, -- before the text", () => {
    expect(desktopNotifyArgv("t", "b", 2, "linux")).toEqual(["notify-send", "-a", "agentglass", "-u", "critical", "--", "t", "b"]);
    expect(desktopNotifyArgv("t", "b", 1, "linux")).toEqual(["notify-send", "-a", "agentglass", "-u", "normal", "--", "t", "b"]);
  });

  test("anything that is not a Mac gets the notify-send spelling", () => {
    expect(desktopNotifyArgv("t", "b", 1, "freebsd")[0]).toBe("notify-send");
  });
});
