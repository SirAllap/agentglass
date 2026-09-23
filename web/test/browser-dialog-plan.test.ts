/*
 * A page's confirm() and prompt() are answered for it, so it never hangs. The
 * default answer was fixed at "yes", which made every "are you sure?" path
 * untestable: the dialog verb arms a different answer, and this runs the real
 * collector in a bare context to see what a page's own call gets back.
 */
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { COLLECTOR } from "../src/lib/browserObserve.ts";

function page() {
  const XHR = function () {} as unknown as { prototype: object };
  XHR.prototype = { open() {}, send() {}, addEventListener() {}, setRequestHeader() {} };
  const ctx: Record<string, unknown> = {
    addEventListener() {}, location: { href: "http://localhost/" }, alert() {}, confirm: () => true, prompt: () => "",
    fetch() {}, XMLHttpRequest: XHR, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    performance: { now: () => 1, getEntriesByType: () => [] }, document: { addEventListener() {}, readyState: "complete" },
    setTimeout, clearTimeout, WebSocket: function () {}, Promise, Date, JSON, String, Array, Object, Math, Error, RegExp,
    Number, Set, Map, URL,
    PerformanceObserver: function (this: { observe: () => void }) { this.observe = () => {}; },
    MutationObserver: function (this: { observe: () => void }) { this.observe = () => {}; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(COLLECTOR, ctx);
  const say = (js: string) => vm.runInContext(js, ctx);
  return { say, arm: (plan: object) => say(`window.__agxDialogPlan = ${JSON.stringify(plan)}`) };
}

describe("dialog answers", () => {
  test("with nothing armed a confirm is yes and a prompt returns its default", () => {
    const p = page();
    expect(p.say(`confirm("sure?")`)).toBe(true);
    expect(p.say(`prompt("name?", "anon")`)).toBe("anon");
  });

  test("a dismissed plan answers the next confirm no, and is spent by it", () => {
    const p = page();
    p.arm({ accept: false, text: null, always: false });
    expect(p.say(`confirm("sure?")`)).toBe(false);
    expect(p.say(`window.__agxDialog.answered`)).toBe(false);
    expect(p.say(`confirm("again?")`)).toBe(true);
  });

  test("a dismissed prompt is null, an accepted one takes the text", () => {
    const p = page();
    p.arm({ accept: false, text: null, always: false });
    expect(p.say(`prompt("name?", "anon")`)).toBeNull();
    p.arm({ accept: true, text: "ada", always: false });
    expect(p.say(`prompt("name?", "anon")`)).toBe("ada");
  });

  test("always keeps answering until it is replaced", () => {
    const p = page();
    p.arm({ accept: false, text: null, always: true });
    expect(p.say(`[confirm("a"), confirm("b"), confirm("c")]`).join()).toBe("false,false,false");
  });

  test("an alert is not spent by a plan meant for a confirm", () => {
    const p = page();
    p.arm({ accept: false, text: null, always: false });
    p.say(`alert("hi")`);
    expect(p.say(`confirm("sure?")`)).toBe(false);
  });
});
