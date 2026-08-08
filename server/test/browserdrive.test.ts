/*
 * The relay that lets an agent drive the browser with your logins in it.
 *
 * What is worth pinning here is not the happy path — it is the three ways this
 * shape goes wrong in a way nobody notices until an agent is stuck:
 *
 *   * nobody is listening (the window is shut), which must fail in
 *     milliseconds with a sentence, not in forty-five seconds with silence;
 *   * an answer that arrives after its timeout, which must be dropped rather
 *     than resolve something else;
 *   * an argument that is really a script — `javascript:`, a selector with a
 *     newline in it — because every one of these verbs ends up inside the page.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  askBrowser, browserReadyCount, noteBrowserReady, parseAsk, pendingBrowserCount, resetBrowserDrive,
  safeUrl, setBrowserSink, settleBrowser,
} from "../src/browserdrive.ts";

afterEach(() => resetBrowserDrive());

/** A window that answers whatever it is told to answer, and has said it can. */
const window = (reply: (id: string) => void) => {
  setBrowserSink({ send: (ask) => reply(ask.id), listeners: () => 1 });
  noteBrowserReady("w1", true);
};

describe("what may be asked", () => {
  test("only http(s) — an `open` that takes javascript: is the eval this does not have", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("http://localhost:3000")).toBeTruthy();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///home/dev/.ssh/id_rsa")).toBeNull();
    expect(safeUrl("data:text/html,<script>")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });

  test("the metadata endpoint is refused however it is spelled — including v6-mapped and NAT64/6to4", () => {
    // The SSRF gate: `open` drives a logged-in browser and `read` hands the page
    // back, so a reachable 169.254.169.254 is a credentialed metadata exfil. It
    // must stay shut whether the address is dotted, an integer/hex packing the
    // URL parser normalizes, the IPv4-mapped/compatible IPv6 form that once
    // slipped past a check that only knew `fe80::/10` and `::`, or a NAT64/6to4
    // embedding that packs the same v4 under a routable-looking prefix.
    for (const u of [
      "http://169.254.169.254/",
      "http://2852039166/",
      "http://0xA9FEA9FE/",
      "http://[::ffff:169.254.169.254]/", // parser folds to ::ffff:a9fe:a9fe
      "http://[::169.254.169.254]/",      // deprecated IPv4-compatible
      "http://[::ffff:a9fe:a9fe]/",       // already-hex IPv4-mapped
      "http://[::ffff:0:0]/",             // mapped 0.0.0.0
      "http://[::]/",                     // unspecified
      "http://[64:ff9b::a9fe:a9fe]/",     // NAT64 64:ff9b::/96, low 32 bits = a9fe:a9fe
      "http://[64:ff9b::169.254.169.254]/", // same, spelled with a dotted-quad tail
      "http://[2002:a9fe:a9fe::]/",       // 6to4 2002::/16 encoding 169.254.169.254
      "http://[2002::1]/",                // 6to4 folds to 0.0.0.0, which is also refused
    ]) expect(safeUrl(u)).toBeNull();
    // Deliberately NOT blocked: localhost, the LAN, a dev box — including their
    // v6-mapped spellings — because pointing the browser at your own machine is
    // ordinary use, not an SSRF. Nor the global v6 internet: a routable address
    // is never folded, and one whose low bits merely resemble 169.254.x.x, or a
    // 6to4 that carries a public v4, must pass — the fold is applied only when
    // the NAT64/6to4 prefix actually matches.
    for (const u of [
      "https://gmail.com/",
      "http://localhost:3000/",
      "http://192.168.1.10/",
      "http://10.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2606:4700::1]/",           // a global v6 — never folded, never blocked
      "http://[2002:808:808::1]/",        // 6to4 of 8.8.8.8 — a public v4, not metadata
      "http://[2001:db8::a9fe:a9fe]/",    // global v6 whose low bits only look like 169.254
    ]) expect(safeUrl(u)).toBeTruthy();
  });

  test("a selector is one short line", () => {
    expect("ask" in parseAsk("click", { selector: "#login button.primary" })).toBe(true);
    expect("error" in parseAsk("click", { selector: "a\nb" })).toBe(true);
    expect("error" in parseAsk("click", { selector: "" })).toBe(true);
    expect("error" in parseAsk("click", { selector: "x".repeat(600) })).toBe(true);
  });

  test("typing carries its text and whether to submit", () => {
    const p = parseAsk("type", { selector: "#q", text: "hello", submit: true });
    expect("ask" in p && p.ask.args).toEqual({ selector: "#q", text: "hello", submit: true });
    // Absent means no: an agent that meant to submit says so.
    const q = parseAsk("type", { selector: "#q", text: "hello" });
    expect("ask" in q && q.ask.args.submit).toBe(false);
  });

  test("scroll takes exactly one of its three ways", () => {
    expect("ask" in parseAsk("scroll", { to: "bottom" })).toBe(true);
    expect("ask" in parseAsk("scroll", { by: -400 })).toBe(true);
    expect("ask" in parseAsk("scroll", { selector: "#footer" })).toBe(true);
    // Two of them has no single answer, and picking one quietly is how an agent
    // describes a part of the page it never reached.
    expect("error" in parseAsk("scroll", { to: "top", by: 100 })).toBe(true);
    expect("error" in parseAsk("scroll", {})).toBe(true);
    expect("error" in parseAsk("scroll", { to: "sideways" })).toBe(true);
    expect("error" in parseAsk("scroll", { by: "lots" })).toBe(true);
    expect("error" in parseAsk("scroll", { by: 5e9 })).toBe(true);
  });

  test("press takes a key that is not text, from a closed list", () => {
    expect("ask" in parseAsk("press", { key: "Enter" })).toBe(true);
    expect("ask" in parseAsk("press", { key: "ArrowDown" })).toBe(true);
    // A letter is not refused because it is dangerous — `type` puts letters in
    // fields — but because the page would ignore it and say nothing.
    expect("error" in parseAsk("press", { key: "a" })).toBe(true);
    expect("error" in parseAsk("press", { key: "" })).toBe(true);
    expect("error" in parseAsk("press", {})).toBe(true);
  });

  test("text wants a selector; back and forward want nothing", () => {
    expect("error" in parseAsk("text", {})).toBe(true);
    expect("ask" in parseAsk("text", { selector: "h1" })).toBe(true);
    expect("ask" in parseAsk("back", {})).toBe(true);
    expect("ask" in parseAsk("forward", { selector: "ignored" })).toBe(true);
  });

  test("an unknown verb is refused rather than relayed", () => {
    expect("error" in parseAsk("eval", { code: "fetch('/steal')" })).toBe(true);
    expect("error" in parseAsk("screenshot", {})).toBe(true);
  });

  test("read and shot take nothing at all", () => {
    expect("ask" in parseAsk("read", { selector: "ignored" })).toBe(true);
    const p = parseAsk("shot", {});
    expect("ask" in p && p.ask.args).toEqual({});
  });
});

describe("asking", () => {
  test("a socket is not a browser: only a window that says it can drive counts", async () => {
    // The ask goes to every open client, and a dashboard in an ordinary browser
    // tab is a client with no <webview> in it. Counting sockets had that tab
    // answering "the browser view is not open in this window" for everybody,
    // first reply winning, while the desktop app sat there able to do the work.
    setBrowserSink({ send: () => { throw new Error("must not be sent"); }, listeners: () => 3 });
    expect(browserReadyCount()).toBe(0);
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(false);
    // "The view is not open", not "the window is not open": the caller can fix
    // the first by opening a pane and cannot fix the second at all, and saying
    // the wrong one cost this feature a whole build.
    expect(r.error).toContain("view is not open");
  });

  test("and a window that says goodbye stops counting", () => {
    noteBrowserReady("w1", true);
    expect(browserReadyCount()).toBe(1);
    noteBrowserReady("w1", false);
    expect(browserReadyCount()).toBe(0);
    // Junk is not a registration.
    expect(noteBrowserReady(42, true)).toBe(false);
    expect(noteBrowserReady("", true)).toBe(false);
    expect(browserReadyCount()).toBe(0);
  });

  test("with no window open it fails at once, and says why", async () => {
    setBrowserSink({ send: () => { throw new Error("must not be sent"); }, listeners: () => 0 });
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const started = Bun.nanoseconds();
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("window is not open");
    // Fast, not "after the read timeout" — the whole point.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(200);
    expect(pendingBrowserCount()).toBe(0);
  });

  test("the window's answer is the request's answer", async () => {
    window((id) => queueMicrotask(() => settleBrowser(id, { ok: true, value: { title: "Dashboard" } })));
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect(r).toEqual({ ok: true, value: { title: "Dashboard" }, error: undefined });
    expect(pendingBrowserCount()).toBe(0);
  });

  test("a failure from the page comes back as one, not as a timeout", async () => {
    window((id) => queueMicrotask(() => settleBrowser(id, { ok: false, error: "nothing matches #nope" })));
    const p = parseAsk("click", { selector: "#nope" });
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nothing matches #nope");
  });

  test("an answer to an id nobody is waiting for is dropped", () => {
    expect(settleBrowser("b999", { ok: true })).toBe(false);
    expect(settleBrowser(undefined, { ok: true })).toBe(false);
  });

  test("two asks in flight do not answer each other", async () => {
    const ids: string[] = [];
    setBrowserSink({ send: (a) => ids.push(a.id), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const a = parseAsk("read", {}), b = parseAsk("shot", {});
    if (!("ask" in a) || !("ask" in b)) throw new Error("unreachable");
    const pa = askBrowser(a.ask), pb = askBrowser(b.ask);
    expect(pendingBrowserCount()).toBe(2);
    settleBrowser(ids[1]!, { ok: true, value: "shot" });
    settleBrowser(ids[0]!, { ok: true, value: "read" });
    expect((await pa).value).toBe("read");
    expect((await pb).value).toBe("shot");
  });
});
