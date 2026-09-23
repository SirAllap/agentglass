/*
 * Input a page can tell from a script. There is no renderer here, so the rule
 * is asserted against the driver's source (and proven for real by the agx-bench
 * task p2-real-input, which reads what the page saw).
 */
import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(new URL("../src/lib/browserDrive.ts", import.meta.url)).text();
const body = (from: string) => {
  const a = SRC.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  // Up to the next case that has a body of its own: stacked labels share one.
  const b = SRC.indexOf("\n      case ", SRC.indexOf("{\n", a));
  return SRC.slice(a, b);
};

describe("real input", () => {
  test("click and the point acts run as a user gesture, under emulated focus", () => {
    for (const from of ['      case "click": {', '      case "dblclick":']) {
      const s = body(from);
      expect(s).toContain("withFocus(cdp");
      expect(s).toMatch(/\), true\)\)/);
    }
  });

  test("reads never claim a gesture", () => {
    for (const from of ['      case "read": {', '      case "text": {']) {
      expect(body(from)).not.toMatch(/\), true\)/);
    }
  });

  test("focus emulation is switched off in finally, so a page does not keep believing it", () => {
    const a = SRC.indexOf("async function withFocus<T>(");
    const fn = SRC.slice(a, SRC.indexOf("\n}\n", a));
    expect(fn).toContain("finally");
    expect(fn).toMatch(/enabled: false/);
  });

  test("hover also moves a real pointer, best effort", () => {
    const s = body('      case "dblclick":');
    expect(s).toContain('type: "mouseMoved"');
    expect(s).toContain(".catch(() => {})");
  });

  test("type has a rich-editor path that goes through the editing command, not a value setter", () => {
    const s = body('      case "type": {');
    expect(s).toContain("isContentEditable");
    expect(s).toContain('execCommand("insertText"');
  });

  test("the raw cdp verb still refuses Input.*", () => {
    expect(SRC).toContain('if (/^Input\\./.test(method)) {');
  });
});
