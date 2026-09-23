/*
 * `scrape`: several pages, one read each, in parallel, each in a tab of its
 * own that is closed again whatever happened in it. Run against a stand-in
 * window that answers every ask and keeps count, because the claims are
 * about the asks — at most N tabs open at once, closetab after a failed read,
 * rows in the caller's order — not about any page.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  noteBrowserReady, parseScrape, resetBrowserDrive, runScrape, setBrowserSink, settleBrowser, type BrowserWireAsk,
} from "../src/browserdrive.ts";

describe("what a scrape may ask for", () => {
  afterEach(() => { delete process.env.AGENTGLASS_BROWSER_ORIGINS; });

  test("every url is held to what one open is held to, and the list is capped", () => {
    expect("error" in parseScrape({})).toBe(true);
    expect("error" in parseScrape({ urls: [] })).toBe(true);
    expect("error" in parseScrape({ urls: ["javascript:alert(1)"] })).toBe(true);
    expect("error" in parseScrape({ urls: ["http://169.254.169.254/"] })).toBe(true);
    expect("error" in parseScrape({ urls: Array.from({ length: 41 }, (_, i) => `https://orbit.example/${i}`) })).toBe(true);
    process.env.AGENTGLASS_BROWSER_ORIGINS = "orbit.example";
    expect("error" in parseScrape({ urls: ["https://orbit.example/a", "https://elsewhere.example/b"] })).toBe(true);
    const ok = parseScrape({ urls: ["https://orbit.example/a"] });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok).toMatchObject({ urls: ["https://orbit.example/a"], read: "markdown", concurrency: 2, profile: "" });
  });

  test("the read is one of the whole-page readers, extract brings its fields, and concurrency is 1 to 4", () => {
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], read: "text" })).toBe(true);
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], read: "click" })).toBe(true);
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], read: "extract" })).toBe(true);
    const ex = parseScrape({ urls: ["https://orbit.example/"], read: "extract", fields: { price: ".price" } });
    if ("error" in ex) throw new Error(ex.error);
    expect(ex.fields).toEqual({ price: ".price" });
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], concurrency: 0 })).toBe(true);
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], concurrency: 5 })).toBe(true);
    expect("error" in parseScrape({ urls: ["https://orbit.example/"], concurrency: 2.5 })).toBe(true);
    const c = parseScrape({ urls: ["https://orbit.example/"], concurrency: 4, profile: "orbit-bot" });
    if ("error" in c) throw new Error(c.error);
    expect(c).toMatchObject({ concurrency: 4, profile: "orbit-bot" });
  });
});

describe("running one", () => {
  afterEach(() => resetBrowserDrive());

  /** A window that opens a tab per newtab, answers the read, and closes on
   *  request — with a little latency, so overlap is real and measurable. */
  function fakeWindow(opts: { failRead?: (url: string) => boolean; failOpen?: (url: string) => boolean } = {}) {
    const asks: BrowserWireAsk[] = [];
    let open = 0;
    let peak = 0;
    let minted = 0;
    const urlOfTab = new Map<string, string>();
    setBrowserSink({
      listeners: () => 1,
      send: (ask) => {
        asks.push(ask);
        const later = (reply: Parameters<typeof settleBrowser>[1]) => setTimeout(() => settleBrowser(ask.id, reply), 15);
        if (ask.op === "newtab") {
          const url = String(ask.args.url);
          if (opts.failOpen?.(url)) return later({ ok: false, error: `could not open ${url}` });
          open++;
          peak = Math.max(peak, open);
          const id = `t${++minted}`;
          urlOfTab.set(id, url);
          return later({ ok: true, value: { id, url, title: "t" } });
        }
        if (ask.op === "closetab") {
          open--;
          return later({ ok: true, value: { closed: ask.args.id } });
        }
        const url = urlOfTab.get(String(ask.args.page)) ?? "";
        if (opts.failRead?.(url)) return later({ ok: false, error: `the page threw on ${url}` });
        return later({ ok: true, value: { url, markdown: `# ${url}` } });
      },
    });
    noteBrowserReady("w-scrape", true);
    return { asks, peak: () => peak, open: () => open };
  }

  test("at most `concurrency` tabs are open at once, and rows come back in the caller's order", async () => {
    const win = fakeWindow();
    const urls = Array.from({ length: 6 }, (_, i) => `https://orbit.example/p${i}`);
    const r = await runScrape({ urls, read: "markdown", concurrency: 2, profile: "orbit-bot" }, { as: "orbit-bot" });
    expect(r.ok).toBe(true);
    expect(r.value.failed).toBe(0);
    expect(r.value.pages.map((p) => p.url)).toEqual(urls);
    expect(r.value.pages.every((p) => p.ok && (p.value as { markdown: string }).markdown === `# ${p.url}`)).toBe(true);
    expect(win.peak(), "two at a time, and it did overlap").toBe(2);
    expect(win.open(), "every tab was closed again").toBe(0);
    // Each read went to the tab that was opened for it, and everything carried the caller.
    const reads = win.asks.filter((a) => a.op === "markdown");
    expect(reads).toHaveLength(6);
    expect(new Set(reads.map((a) => a.args.page)).size).toBe(6);
    expect(win.asks.every((a) => a.args.as === "orbit-bot")).toBe(true);
    expect(win.asks.filter((a) => a.op === "newtab").every((a) => a.args.profile === "orbit-bot")).toBe(true);
  });

  test("a read that fails is a row with an error, and its tab is still closed", async () => {
    const win = fakeWindow({ failRead: (u) => u.endsWith("/p1") });
    const urls = ["https://orbit.example/p0", "https://orbit.example/p1", "https://orbit.example/p2"];
    const r = await runScrape({ urls, read: "markdown", concurrency: 1, profile: "" });
    expect(r.ok).toBe(true);
    expect(r.value.failed).toBe(1);
    expect(r.value.pages[1]).toMatchObject({ url: urls[1], ok: false });
    expect(r.value.pages[1]!.error).toContain("p1");
    expect(r.value.pages[0]!.ok && r.value.pages[2]!.ok).toBe(true);
    expect(win.open()).toBe(0);
    expect(win.asks.filter((a) => a.op === "closetab")).toHaveLength(3);
    expect(win.peak(), "concurrency 1 is one").toBe(1);
  });

  test("a tab that could not be opened is a row with that reason and nothing more is asked of it", async () => {
    const win = fakeWindow({ failOpen: (u) => u.endsWith("/p0") });
    const r = await runScrape({ urls: ["https://orbit.example/p0", "https://orbit.example/p1"], read: "links", concurrency: 2, profile: "" });
    expect(r.value.pages[0]).toMatchObject({ ok: false, error: "could not open https://orbit.example/p0" });
    expect(r.value.pages[1]!.ok).toBe(true);
    expect(win.asks.filter((a) => a.op === "links")).toHaveLength(1);
    expect(win.asks.filter((a) => a.op === "closetab")).toHaveLength(1);
  });
});
