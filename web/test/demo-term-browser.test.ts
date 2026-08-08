/*
 * The demo's terminal and browser.
 *
 * Both exist because the demo the landing page links to was showing nothing for
 * either: the terminal was a black rectangle with "disabled in the demo"
 * written across it, and the browser had been dropped from the rail entirely.
 * What is locked here is the part a build cannot tell you about — that the
 * replay stops when it is told to, and that the two fabrications agree with the
 * rest of the demo rather than each inventing their own numbers.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { demoTermScript, playDemoSession, type DemoChunk } from "../src/lib/demoTerm.ts";
import { DEMO_BASKET, DEMO_BROWSER_TABS, DEMO_DISCOUNT, DEMO_SHIPPING, money, subtotal, total } from "../src/lib/demoBrowser.ts";
import { DemoPage } from "../src/components/browser/DemoPage.tsx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the canned terminal session", () => {
  test("arrives with scrollback already in it", () => {
    const script = demoTermScript();
    // The first write is the history: a terminal that types its whole past from
    // scratch keeps a visitor waiting to read what was supposed to be there
    // when they arrived.
    expect(script.length).toBeGreaterThan(5);
    expect(script[0]![0].split("\r\n").length).toBeGreaterThan(15);
  });

  test("leaves a prompt, not a half-finished line", () => {
    const script = demoTermScript();
    expect(script.at(-1)![0]).toContain("$");
  });

  test("writes in order and stops when told", async () => {
    const wrote: string[] = [];
    const script: DemoChunk[] = [["one", 1], ["two", 1], ["three", 1], ["four", 1]];
    const stop = playDemoSession({ write: (d) => wrote.push(d) }, script);
    // First chunk is synchronous — the pane is never briefly empty.
    expect(wrote).toEqual(["one"]);
    await sleep(15);
    stop();
    const atStop = wrote.length;
    await sleep(30);
    // The reason this matters: the panel unmounts as views are switched while a
    // terminal outlives it, and a timer chain that survives its xterm writes
    // into a disposed one, which throws from a callback nobody is awaiting.
    expect(wrote.length).toBe(atStop);
  });

  test("stopping before the first timer fires is safe", async () => {
    const wrote: string[] = [];
    const stop = playDemoSession({ write: (d) => wrote.push(d) }, [["a", 5], ["b", 5]]);
    stop();
    await sleep(25);
    expect(wrote).toEqual(["a"]);
  });
});

describe("the demo browser's pages", () => {
  test("adds up the way the canned test run says it does", () => {
    // Quantity-aware: two of a line is twice the line, not once.
    expect(subtotal()).toBe(2 * 1_150 + 2_400 + 4 * 890);
    // The discount applies once, and shipping is not discounted — the other two
    // passing assertions in demoTerm's test output. Written as arithmetic rather
    // than as a number so a change to the basket cannot quietly disagree with
    // the terminal next to it.
    expect(total()).toBe(subtotal() - DEMO_DISCOUNT + DEMO_SHIPPING);
    expect(money(total())).toBe("£82.10");
  });

  test("browses this demo's own machine", () => {
    // The ports panel fabricates vite on 5173 and bun on 3000. A browser tab
    // pointing anywhere else would be a third opinion about one machine.
    for (const t of DEMO_BROWSER_TABS) {
      expect(t.url).toMatch(/^http:\/\/localhost:(5173|3000)\//);
      expect(t.title.length).toBeGreaterThan(0);
    }
  });

  test("draws the storefront, the api and an address it has no page for", () => {
    const shop = renderToStaticMarkup(createElement(DemoPage, { url: "http://localhost:5173/" }));
    expect(shop).toContain("Harbour Goods");
    expect(shop).toContain(money(total()));

    const api = renderToStaticMarkup(createElement(DemoPage, { url: "http://localhost:3000/health" }));
    expect(api).toContain("shop-api");
    expect(api).toContain("uptime_s");

    // Typing an address has to answer something. It used to be a black
    // rectangle, which is the failure this whole change is about.
    const other = renderToStaticMarkup(createElement(DemoPage, { url: "https://example.invalid/thing" }));
    expect(other).toContain("example.invalid");
    expect(other).toContain("isn’t in the demo");
  });

  test("every basket line is drawn", () => {
    const shop = renderToStaticMarkup(createElement(DemoPage, { url: "http://localhost:5173/checkout" }));
    for (const l of DEMO_BASKET) expect(shop).toContain(l.name);
  });
});
