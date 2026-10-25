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
  test("only click carries a user gesture; the point acts run plain", () => {
    const click = body('      case "click": {');
    expect(click).toContain("withFocus(el, cdp");
    // On the script path, PRESS with the gesture; the trusted press has a real one.
    expect(click).toMatch(/\$\{PRESS\}.*, true\) as/);
    const point = body('      case "dblclick":');
    expect(point).not.toContain("withFocus(");
    expect(point).not.toMatch(/\), true\)/);
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

  test("html --clean blanks the value of a hidden or password input", async () => {
    const clean = await Bun.file(new URL("../src/lib/browserCleanHtml.ts", import.meta.url)).text();
    expect(clean).toMatch(/a\.name === "value" && \/\^\(hidden\|password\)\$\/i/);
  });

  /* Trusted first, the script path only when the page saw nothing arrive.
     The behaviour is proven by scripts/trusted-input.ts against a page that
     believes only isTrusted; this pins the order it depends on. */
  test("each pointer act and each key goes through the shell before the script path", () => {
    const before = (from: string, script: string) => {
      const s = body(from);
      const shell = s.indexOf("viaShell(el, input");
      expect(shell, from).toBeGreaterThan(-1);
      expect(s.indexOf(script), from).toBeGreaterThan(shell);
    };
    before('      case "click": {', "${PRESS}");
    before('      case "dblclick":', "${dispatch} return");
    before('      case "type": {', 'execCommand("insertText"');
    before('      case "press": {', 'send("keydown")');
    expect(body('      case "dblclick":')).toContain('const real = ask.op === "dblclick" || ask.op === "hover";');
  });

  test("the script path runs only when the shell sent nothing, so an act is never done twice", () => {
    for (const from of ['      case "click": {', '      case "dblclick":', '      case "type": {', '      case "press": {']) {
      expect(body(from)).toContain("if (via.sent)");
      expect(body(from)).not.toContain("via.got > 0)");
    }
  });

  test("a right-click stays in the page: a real one opens the shell's own menu", () => {
    const point = body('      case "dblclick":');
    expect(point).not.toMatch(/real = [^;]*rightclick/);
  });

  test("the app's focus is put back after the act, to what had it", () => {
    const a = SRC.indexOf("function restoreHostFocus(");
    const fn = SRC.slice(a, SRC.indexOf("\n}\n", a));
    expect(fn).toContain("document.activeElement !== el");
    expect(fn).toContain("b.focus(");
    const v = SRC.indexOf("async function viaShell(");
    const via = SRC.slice(v, SRC.indexOf("\n}\n", v));
    // Right after the send, before the confirmation poll: while the pane holds
    // the app's focus, the person's keys go to the page.
    expect(via.indexOf("restoreHostFocus(el, before)")).toBeGreaterThan(-1);
    expect(via.indexOf("restoreHostFocus(el, before)")).toBeLessThan(via.indexOf("READ_ARMED"));
  });

  test("the raw cdp verb still refuses Input.*", () => {
    expect(SRC).toContain('if (/^Input\\./.test(method)) {');
  });
});

import { handoffUrlMet, withFocus } from "../src/lib/browserDrive.ts";

describe("handoff until", () => {
  test("a path matches the pathname at a boundary, never the query or a longer word", () => {
    expect(handoffUrlMet("/dashboard", "https://acme.test/dashboard")).toBe(true);
    expect(handoffUrlMet("/dashboard", "https://acme.test/dashboard/home")).toBe(true);
    expect(handoffUrlMet("/dashboard", "https://acme.test/login?next=/dashboard")).toBe(false);
    expect(handoffUrlMet("/app", "https://acme.test/apple")).toBe(false);
    expect(handoffUrlMet("/app/", "https://acme.test/app")).toBe(true);
  });

  test("an http url must share the origin", () => {
    expect(handoffUrlMet("https://acme.test/home", "https://acme.test/home")).toBe(true);
    expect(handoffUrlMet("https://acme.test/home", "https://evil.test/home")).toBe(false);
    expect(handoffUrlMet("https://acme.test/home", "https://acme.test/login?u=https://acme.test/home")).toBe(false);
  });

  test("a selector is not a url condition", () => {
    expect(handoffUrlMet("#welcome", "https://acme.test/welcome")).toBe(false);
  });
});

describe("withFocus", () => {
  const rig = () => {
    const calls: boolean[] = [];
    const cdp = async (_m: string, p?: unknown) => { calls.push((p as { enabled: boolean }).enabled); return { ok: true }; };
    return { calls, cdp };
  };

  test("two overlapping acts on one guest switch it on once and off once, after the last", async () => {
    const { calls, cdp } = rig();
    const el = {};
    let release!: () => void;
    const slow = withFocus(el, cdp, () => new Promise<void>((r) => { release = r; }));
    await Bun.sleep(5);
    await withFocus(el, cdp, async () => {});
    expect(calls).toEqual([true]); // the short act ending did not switch it off under the long one
    release();
    await slow;
    expect(calls).toEqual([true, false]);
  });

  test("an act that never settles is cut off, and the flag still goes off", async () => {
    const { calls, cdp } = rig();
    await expect(withFocus({}, cdp, () => new Promise(() => {}), 20)).rejects.toThrow("did not finish");
    expect(calls).toEqual([true, false]);
  });
});
