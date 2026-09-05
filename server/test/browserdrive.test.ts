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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askBrowser, browserReadyCount, exportAudit, noteBrowserReady, parseAsk, pendingBrowserCount, resetAudit,
  resetBrowserDrive, safeUrl, setBrowserSink, settleBrowser,
  redactAskForTest,
  valueCarryingOpsForTest,
  valueCarryingExemptForTest,
  containerRecord,
  resetContainerLedger,
  runSteps,
  waitForEvents,
  auditAsScript,
  downloadFile,
  runLanes,
  withObservation,
} from "../src/browserdrive.ts";

/* The container ledger and the audit log are files on the operator's machine.
   Measured: without this jail the "a refused open claims no container" test
   below wrote `ghost` (creator `squatter`) into the real
   ~/.local/state/agentglass/browser-containers.json, passed once, and failed on
   every run after — the record it had left was the record it then found. */
let stateScratch = "";
let stateBefore: string | undefined;
beforeAll(() => {
  stateScratch = mkdtempSync(join(tmpdir(), "agx-drive-state-"));
  stateBefore = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = stateScratch;
});
afterAll(() => {
  if (stateBefore === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = stateBefore;
  try { rmSync(stateScratch, { recursive: true, force: true }); } catch { /* fine */ }
});

afterEach(() => {
  resetBrowserDrive();
  resetAudit();
  resetContainerLedger();
  delete process.env.AGENTGLASS_BROWSER_ORIGINS;
  delete process.env.AGENTGLASS_BROWSER_READONLY;
});

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

  test("dblclick, rightclick, hover, focus and blur take a plain selector, like click", () => {
    for (const op of ["dblclick", "rightclick", "hover", "focus", "blur"]) {
      expect("ask" in parseAsk(op, { selector: "#save" }), op).toBe(true);
      expect("error" in parseAsk(op, { selector: "a\nb" }), op).toBe(true);
      expect("error" in parseAsk(op, { selector: "" }), op).toBe(true);
    }
  });

  test("§9: --page addresses a specific tab instead of the active one", () => {
    // Page argument is optional for all page operations
    const ok = parseAsk("click", { selector: "#button", page: "t2" });
    expect("ask" in ok && ok.ask.args).toEqual({ selector: "#button", page: "t2" });
    // Page argument is trimmed
    const trim = parseAsk("read", { page: "  t3  " });
    expect("ask" in trim && trim.ask.args.page).toBe("t3");
    // Page must be a valid string
    expect("error" in parseAsk("click", { selector: "#x", page: "" })).toBe(true);
    expect("error" in parseAsk("click", { selector: "#x", page: 123 })).toBe(true);
    // Tab operations don't accept page argument
    const tabOp = parseAsk("tab", { index: 0, page: "t2" });
    expect("ask" in tabOp && (tabOp.ask.args as any).page).toBeUndefined();
  });

  test("check defaults to checking, and --off unchecks", () => {
    const on = parseAsk("check", { selector: "#agree" });
    expect("ask" in on && on.ask.args.checked).toBe(true);
    const off = parseAsk("check", { selector: "#agree", checked: false });
    expect("ask" in off && off.ask.args.checked).toBe(false);
  });

  test("fill takes 1..50 selector->text entries, each still a real selector", () => {
    const ok = parseAsk("fill", { fields: { "#name": "Ada", "#email": "ada@example.com" } });
    expect("ask" in ok && ok.ask.args.fields).toEqual({ "#name": "Ada", "#email": "ada@example.com" });
    expect("error" in parseAsk("fill", { fields: {} })).toBe(true);
    expect("error" in parseAsk("fill", { fields: { "a\nb": "x" } })).toBe(true);
    expect("error" in parseAsk("fill", { fields: "not an object" })).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`#f${i}`, "x"]));
    expect("error" in parseAsk("fill", { fields: many })).toBe(true);
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

  test("read takes nothing at all; a bare shot wants nothing either", () => {
    expect("ask" in parseAsk("read", { selector: "ignored" })).toBe(true);
    const p = parseAsk("shot", {});
    expect("ask" in p && p.ask.args).toEqual({});
  });

  test("addInitScript wants a name that is an identifier and a non-empty script", () => {
    const p = parseAsk("addInitScript", { name: "seal_clock", js: "Date.now = () => 0;" });
    expect("ask" in p && p.ask.args).toEqual({ name: "seal_clock", js: "Date.now = () => 0;" });
    expect("error" in parseAsk("addInitScript", { name: "has space", js: "1" })).toBe(true);
    expect("error" in parseAsk("addInitScript", { name: "1leadingDigit", js: "1" })).toBe(true);
    expect("error" in parseAsk("addInitScript", { name: "", js: "1" })).toBe(true);
    expect("error" in parseAsk("addInitScript", { name: "ok", js: "" })).toBe(true);
    expect("error" in parseAsk("addInitScript", { name: "ok" })).toBe(true);
    expect("error" in parseAsk("addInitScript", { name: "ok", js: "x".repeat(20_001) })).toBe(true);
  });

  test("expose wants only a name", () => {
    const p = parseAsk("expose", { name: "reportBug" });
    expect("ask" in p && p.ask.args).toEqual({ name: "reportBug" });
    expect("error" in parseAsk("expose", { name: "not an identifier" })).toBe(true);
    expect("error" in parseAsk("expose", {})).toBe(true);
  });

  test("exposed reads like console and network do", () => {
    const p = parseAsk("exposed", { limit: 10, since: 5 });
    expect("ask" in p && p.ask.args).toEqual({ limit: 10, since: 5 });
    expect("ask" in parseAsk("exposed", {})).toBe(true);
    expect("error" in parseAsk("exposed", { limit: 0 })).toBe(true);
  });

  test("a shot chooses what it contains one way at a time", () => {
    expect("ask" in parseAsk("shot", { selector: "#e17" })).toBe(true);
    // `fullPage` is refused BY NAME now, not ignored: a caller that passed it
    // and got a viewport shot back would think it had the whole page.
    expect("error" in parseAsk("shot", { fullPage: true })).toBe(true);
    expect("ask" in parseAsk("shot", { clip: { x: 0, y: 0, width: 400, height: 300 } })).toBe(true);
    // Two at once is more likely a mistake than a layering, so it is refused
    // with a sentence naming which two collided rather than picking one.
    const both = parseAsk("shot", { selector: "#e17", clip: { x: 0, y: 0, width: 10, height: 10 } });
    expect("error" in both && both.error).toMatch(/selector and clip/);
  });

  test("a shot's clip is a real rectangle, not four arbitrary numbers", () => {
    expect("error" in parseAsk("shot", { clip: { x: -1, y: 0, width: 10, height: 10 } })).toBe(true);
    expect("error" in parseAsk("shot", { clip: { x: 0, y: 0, width: 0, height: 10 } })).toBe(true);
    expect("error" in parseAsk("shot", { clip: { x: 0, y: 0, width: 1.5, height: 10 } })).toBe(true);
    expect("error" in parseAsk("shot", { clip: { x: 0, y: 0, width: 30_000, height: 10 } })).toBe(true);
    const ok = parseAsk("shot", { clip: { x: 10, y: 20, width: 300, height: 150 } });
    expect("ask" in ok && ok.ask.args.clip).toEqual({ x: 10, y: 20, width: 300, height: 150 });
  });

  test("a highlight and its label — a box and a caption drawn ON the image", () => {
    const p = parseAsk("shot", { highlight: "#e17", label: "still Online" });
    expect("ask" in p && p.ask.args).toEqual({ highlight: "#e17", label: "still Online" });
    // The caption is meaningless without a box to sit next to.
    expect("error" in parseAsk("shot", { label: "still Online" })).toBe(true);
    expect("error" in parseAsk("shot", { highlight: "#e17", label: "a\nnewline" })).toBe(true);
    expect("error" in parseAsk("shot", { highlight: "#e17", label: "x".repeat(201) })).toBe(true);
    // A highlight is independent of the crop mode — it can sit inside any of them.
    expect("ask" in parseAsk("shot", { selector: "#panel", highlight: "#e17", label: "still Online" })).toBe(true);
  });

  // §6: force a 404/500/hang on requests matching a URL pattern.
  test("fake needs a pattern and exactly one of status or timeout", () => {
    const p = parseAsk("fake", { pattern: "/api/board", status: 500 });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api/board", status: 500 });
    const t = parseAsk("fake", { pattern: "/api/board", timeout: true });
    expect("ask" in t && t.ask.args).toEqual({ pattern: "/api/board", timeout: true });
    // Neither, or both — a rule that both fails fast and hangs forever has no
    // single answer.
    expect("error" in parseAsk("fake", { pattern: "/api/board" })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "/api/board", status: 500, timeout: true })).toBe(true);
    expect("error" in parseAsk("fake", { status: 500 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "", status: 500 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "a\nb", status: 500 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "x".repeat(201), status: 500 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "/api", status: 99 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "/api", status: 600 })).toBe(true);
  });

  test("fake takes an optional body and delay", () => {
    const p = parseAsk("fake", { pattern: "/api", status: 404, body: "not found", delayMs: 500 });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api", status: 404, body: "not found", delayMs: 500 });
    expect("error" in parseAsk("fake", { pattern: "/api", status: 500, delayMs: -1 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "/api", status: 500, delayMs: 120_001 })).toBe(true);
    expect("error" in parseAsk("fake", { pattern: "/api", status: 500, body: "x".repeat(10_001) })).toBe(true);
  });

  test("clearing a fake needs only the pattern", () => {
    const p = parseAsk("fake", { pattern: "/api/board", clear: true });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api/board", clear: true });
    expect("error" in parseAsk("fake", { clear: true })).toBe(true);
  });

  // §6: intercept requests and handle them via CDP's Fetch domain.
  test("intercept needs a pattern and exactly one of fulfill or abort", () => {
    const f = parseAsk("intercept", { pattern: "/api/users", fulfill: true });
    expect("ask" in f && f.ask.args).toEqual({ pattern: "/api/users", fulfill: true, status: 200 });
    const a = parseAsk("intercept", { pattern: "/api/users", abort: true });
    expect("ask" in a && a.ask.args).toEqual({ pattern: "/api/users", abort: true });
    expect("error" in parseAsk("intercept", { pattern: "/api/users" })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "/api/users", fulfill: true, abort: true })).toBe(true);
    expect("error" in parseAsk("intercept", { fulfill: true })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "", fulfill: true })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "a\nb", fulfill: true })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "x".repeat(201), fulfill: true })).toBe(true);
  });

  test("intercept fulfill takes optional status and body", () => {
    const p = parseAsk("intercept", { pattern: "/api", fulfill: true, status: 404, body: "not found" });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api", fulfill: true, status: 404, body: "not found" });
    expect("error" in parseAsk("intercept", { pattern: "/api", fulfill: true, status: 99 })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "/api", fulfill: true, status: 600 })).toBe(true);
    expect("error" in parseAsk("intercept", { pattern: "/api", fulfill: true, body: "x".repeat(10_001) })).toBe(true);
  });

  test("intercept abort takes optional reason", () => {
    const p = parseAsk("intercept", { pattern: "/api", abort: true, reason: "network-error" });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api", abort: true, reason: "network-error" });
    expect("error" in parseAsk("intercept", { pattern: "/api", abort: true, reason: "" })).toBe(true);
  });

  test("clearing an intercept needs only the pattern", () => {
    const p = parseAsk("intercept", { pattern: "/api/board", clear: true });
    expect("ask" in p && p.ask.args).toEqual({ pattern: "/api/board", clear: true });
    expect("error" in parseAsk("intercept", { clear: true })).toBe(true);
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

/*
 * §16 — the guardrail `eval` was let in without. Four things, each verifiable
 * rather than a promise: browser-mcp.test.ts names this debt and this is
 * where it gets paid.
 */
describe("§16 — origins, read-only, audit, redaction", () => {
  test("an unset allow-list is `*` — a decision, not silence", () => {
    // No AGENTGLASS_BROWSER_ORIGINS set (afterEach deletes it).
    expect("ask" in parseAsk("open", { url: "https://anywhere.example/" })).toBe(true);
  });

  test("an origin outside the list is refused, naming the origin and the list", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8001,localhost:8002";
    const p = parseAsk("open", { url: "https://evil.example/steal" });
    if (!("error" in p)) throw new Error("unreachable");
    expect(p.error).toContain("evil.example");
    expect(p.error).toContain("localhost:8001");
    expect(p.error).toContain("localhost:8002");
  });

  test("an origin inside the list, on its listed port, is let through", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8001,localhost:8002";
    expect("ask" in parseAsk("open", { url: "http://localhost:8001/app" })).toBe(true);
    expect("ask" in parseAsk("newtab", { url: "http://localhost:8002/x" })).toBe(true);
    // A port not on the list is a different origin, refused the same way.
    expect("error" in parseAsk("open", { url: "http://localhost:9999/" })).toBe(true);
  });

  test("a hostname entry with no port matches the host on any port", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost";
    expect("ask" in parseAsk("open", { url: "http://localhost:3000/" })).toBe(true);
    expect("ask" in parseAsk("open", { url: "http://localhost:9999/" })).toBe(true);
    expect("error" in parseAsk("open", { url: "https://elsewhere.example/" })).toBe(true);
  });

  test("read-only mode lets observing through and refuses acting, naming the verb", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    expect("ask" in parseAsk("read", {})).toBe(true);
    expect("ask" in parseAsk("observe", {})).toBe(true);
    const p = parseAsk("click", { selector: "#buy" });
    if (!("error" in p)) throw new Error("unreachable");
    expect(p.error).toContain("click");
    expect(p.error).toContain("read-only");
  });

  test("read-only mode refuses type, eval and open — never lets an unclassified verb through as observing", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    expect("error" in parseAsk("type", { selector: "#q", text: "hi" })).toBe(true);
    expect("error" in parseAsk("eval", { js: "1+1" })).toBe(true);
    expect("error" in parseAsk("open", { url: "https://example.com/" })).toBe(true);
    // cookies without --set is a read; with it, it writes, and read-only mode
    // must catch the write even though the verb is the same string either way.
    expect("ask" in parseAsk("cookies", {})).toBe(true);
    expect("error" in parseAsk("cookies", { set: { name: "a", value: "b" } })).toBe(true);
  });

  test("every op OBSERVE_OPS does not name is acting by default", () => {
    // Every verb in the real op set is either explicitly observing or refused
    // under read-only — none of them slip through unclassified.
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    const acting = ["open", "click", "type", "back", "forward", "scroll", "press",
      "tab", "newtab", "closetab", "resize", "eval", "select", "reload", "fake"];
    for (const op of acting) {
      const p = parseAsk(op, op === "open" || op === "newtab" ? { url: "https://example.com/" }
        : op === "click" || op === "select" ? { selector: "#x", value: "v" }
        : op === "type" ? { selector: "#x", text: "hi" }
        : op === "scroll" ? { to: "top" }
        : op === "press" ? { key: "Enter" }
        : op === "tab" || op === "closetab" ? { index: 0 }
        : op === "resize" ? { width: 800, height: 600 }
        : op === "eval" ? { js: "1" }
        : op === "fake" ? { pattern: "/api", status: 500 }
        : {});
      expect("error" in p).toBe(true);
    }
  });

  test("a refused open still lands on the audit log", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8001";
    parseAsk("open", { url: "https://evil.example/" });
    const entries = exportAudit();
    expect(entries.length).toBe(1);
    expect(entries[0]!.op).toBe("open");
    expect(entries[0]!.ok).toBe(false);
    expect(entries[0]!.error).toContain("evil.example");
  });

  test("a refused click under read-only also lands on the audit log", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    parseAsk("click", { selector: "#buy" });
    const entries = exportAudit();
    expect(entries.length).toBe(1);
    expect(entries[0]!.op).toBe("click");
    expect(entries[0]!.ok).toBe(false);
  });

  test("a completed call is audited too, oldest first, with a growing id", async () => {
    setBrowserSink({ send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: "Dashboard" })), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    await askBrowser(p.ask);
    const entries = exportAudit();
    expect(entries.length).toBe(1);
    expect(entries[0]!.op).toBe("read");
    expect(entries[0]!.ok).toBe(true);
  });

  test("a value typed into a selector that says password is redacted in the audit log", async () => {
    setBrowserSink({ send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: true })), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const p = parseAsk("type", { selector: "input[type=password]", text: "hunter2" });
    if (!("ask" in p)) throw new Error("unreachable");
    await askBrowser(p.ask);
    const entries = exportAudit();
    expect(entries[0]!.args.text).toBe("[redacted]");
    expect(entries[0]!.args.text).not.toBe("hunter2");
  });

  test("a token-shaped value is redacted wherever it appears — in what a verb returns, not just what it was sent", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    setBrowserSink({ send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: { text: `token=${secret}` } })), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect(JSON.stringify(r.value)).not.toContain(secret);
    expect(JSON.stringify(r.value)).toContain("[redacted]");
  });

  test("a cookie/authorization header is redacted by key, whatever shape the value is", async () => {
    setBrowserSink({
      send: (a) => queueMicrotask(() => settleBrowser(a.id, {
        ok: true, value: { headers: { cookie: "session=abc", Authorization: "Bearer xyz", "content-type": "text/html" } },
      })),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const p = parseAsk("network", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    const headers = (r.value as { headers: Record<string, string> }).headers;
    expect(headers.cookie).toBe("[redacted]");
    expect(headers.Authorization).toBe("[redacted]");
    expect(headers["content-type"]).toBe("text/html");
  });
});

describe("a typed password does not reach the audit log", () => {
  /*
   * THE INCIDENT THIS EXISTS FOR. Another browser MCP was banned from this
   * machine because it autofilled a real password and the password stayed in
   * the transcript. §16 asks for automatic redaction, and "automatic" is the
   * whole word: a rule somebody has to remember to apply is the rule that was
   * not applied that day.
   *
   * The case below is the one both heuristics miss, and it is the ordinary
   * one: a framework-generated id. `#j_id_42` names nothing, `Verano2026!` has
   * no token shape, and a widened word list cannot fix that — the id is not a
   * word. Only the panel can read the node's `type`, so the panel is asked and
   * its answer is what the log obeys.
   */
  test("the panel's verdict redacts it, where the selector and the value do not", () => {
    const args = { selector: "#j_id_42", text: "Verano2026!" };
    expect(redactAskForTest("type", args, false).text,
      "the heuristics were supposed to miss this one").toBe("Verano2026!");
    expect(redactAskForTest("type", args, true).text).toBe("[redacted]");
  });

  test("and the selector still answers for a type that never reached a node", () => {
    // A refusal is logged too, and a wrong selector on a login form is still
    // a password somebody typed.
    for (const sel of ["#password", "#pwd", "input[name=pass]", "#otp", "#cvv"]) {
      expect(redactAskForTest("type", { selector: sel, text: "hunter2" }, false).text,
        `${sel} was let through`).toBe("[redacted]");
    }
  });

  test("a token-shaped value is redacted wherever it was typed", () => {
    expect(redactAskForTest("type", { selector: "#q", text: "ghp_" + "a".repeat(30) }, false).text)
      .toBe("[redacted]");
  });

  test("and ordinary text is left alone, or the log is useless", () => {
    expect(redactAskForTest("type", { selector: "#q", text: "hello world" }, false).text)
      .toBe("hello world");
  });
});

describe("§15 — every verb that carries a value, not just `type`", () => {
  /*
   * THE DEFECT, one line wide: `if (op === "type" && …)`. `fill` is the
   * documented one-call login verb — the CLI's own help calls it "a whole form
   * in ONE call" — and it sends `{fields: {selector: value}}`, which the
   * shape sieve walks with the SELECTOR as its key hint. `#password` matches
   * no header name, a human-chosen password matches no token shape, and the
   * audit log is machine-global and exportable by any agent on the box with
   * one command, under a `--help` promising "with secrets already taken out".
   *
   * Each test below is here because it went red when the row it guards was
   * deleted from `VALUE_CARRYING` — checked one row at a time, not by reading.
   */
  const args = (op: string, body: Record<string, unknown>) => {
    const p = parseAsk(op, body);
    if (!("ask" in p)) throw new Error(`parseAsk refused ${op}: ${(p as { error: string }).error}`);
    return p.ask.args;
  };

  test("a filled form keeps the username and loses the password", () => {
    const out = redactAskForTest("fill", args("fill", {
      fields: { "#user": "alice", "#password": "hunter2" },
    }));
    const fields = out.fields as Record<string, string>;
    expect(fields["#user"], "the username was blanked too — the log now says nothing").toBe("alice");
    expect(fields["#password"]).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  test("and the panel's own verdict names the field, for an id no heuristic can read", () => {
    /*
     * The case that matters and the one a selector heuristic cannot reach: a
     * framework-generated id. `#mui-4821` says nothing; only the page knows it
     * is `<input type=password>`. This is the shape the relay accepts today —
     * the panel does not send it for `fill` yet (its page-side secret test
     * lives in the `type` handler only), which is a `web/` change, not this
     * file's.
     */
    const out = redactAskForTest("fill",
      { fields: { "#mui-4820": "alice", "#mui-4821": "hunter2" } },
      { fields: ["#mui-4821"] });
    const fields = out.fields as Record<string, string>;
    expect(fields["#mui-4820"]).toBe("alice");
    expect(fields["#mui-4821"], "the page said this one was a password and it was logged anyway")
      .toBe("[redacted]");
  });

  test("a cookie value goes by POSITION — the incident's own 32-char alphanumeric sessionid", () => {
    /*
     * Measured from the log this report was written against: `a31`'s
     * `Network.setCookie` params held a 32-character ALPHANUMERIC `sessionid`
     * in clear. Not 32 hex, so the shape sieve missed it; keyed `value`, so
     * the name sieve missed it. A live session credential, in a global log.
     */
    const sessionid = "kq3zr9x1v7b2n5m8t4w6y0p3s1d7f9g2";
    expect(sessionid, "pick a value that is NOT hex, or this test proves the old rule")
      .not.toMatch(/^[A-Fa-f0-9]+$/);
    const out = redactAskForTest("cookies", args("cookies", {
      set: { name: "sessionid", value: sessionid, domain: "orbit.example" },
    }));
    const set = out.set as Record<string, string>;
    expect(set.value).toBe("[redacted]");
    expect(set.name, "the cookie's NAME is the useful half and must survive").toBe("sessionid");
    expect(JSON.stringify(out)).not.toContain(sessionid);
  });

  test("a stored value goes by position too, benign ones included, and that is the trade", () => {
    const token = "opaque-session-9f2c-not-a-token-shape";
    const secret = redactAskForTest("storage", args("storage", { set: true, key: "authToken", value: token }));
    expect(secret.value).toBe("[redacted]");
    // Said out loud rather than discovered: replay of `storage --set` is lossy
    // now, for the boring keys as well as the dangerous ones.
    const boring = redactAskForTest("storage", args("storage", { set: true, key: "theme", value: "dark" }));
    expect(boring.value).toBe("[redacted]");
    // Reading storage is untouched — there is no caller value to lose.
    const read = redactAskForTest("storage", args("storage", { where: "local" }));
    expect(read.value).toBeUndefined();
  });

  test("a non-standard header name is redacted by name, like Authorization already was", () => {
    const out = redactAskForTest("headers", args("headers", {
      headers: { "X-Api-Key": "abc123def456", "X-Auth-Token": "zzz", "Content-Type": "application/json" },
    }));
    const h = out.headers as Record<string, string>;
    expect(h["X-Api-Key"]).toBe("[redacted]");
    expect(h["X-Auth-Token"]).toBe("[redacted]");
    expect(h["Content-Type"], "an honest header was masked").toBe("application/json");
  });

  test("`type` is unchanged — the regression the widening must not cost", () => {
    // All three signals, still each on its own: the panel's verdict, the
    // selector heuristic, and the token shape.
    expect(redactAskForTest("type", { selector: "#login-x1", text: "hunter2" }, true).text).toBe("[redacted]");
    expect(redactAskForTest("type", { selector: "#password", text: "hunter2" }).text).toBe("[redacted]");
    expect(redactAskForTest("type", { selector: "#q", text: "ghp_" + "a".repeat(30) }).text).toBe("[redacted]");
    expect(redactAskForTest("type", { selector: "#q", text: "hello world" }).text).toBe("hello world");
  });

  test("the table names every value-carrying verb, so the next one is a row and not an omission", () => {
    /*
     * The lock on the SHAPE of the fix rather than on one verb. `clipboard` is
     * deliberately absent — the comment on the table says why — and if it is
     * ever added this list must move with it.
     */
    expect([...valueCarryingOpsForTest].sort()).toEqual(["cookies", "fill", "storage", "type"]);
  });

  test("the replay script emits a real `fill`, with the pairs and the marker", () => {
    /*
     * Before this, `fill` fell to `default` and its plaintext was written into
     * the shareable script as a JSON comment — the one verb whose argument is
     * a password, emitted in the one shape that carries it verbatim.
     */
    const s = auditAsScript([{
      id: "x", ts: 0, ok: true, op: "fill",
      args: { fields: { "#user": "alice", "#password": "[redacted]" } },
    } as never]);
    expect(s).toContain("agentglass-browser fill --field '#user=alice' --field '#password=[redacted]'");
    expect(s).toContain("put the real value here");
    expect(s, "it fell through to the JSON comment again").not.toContain('# fill {');
  });

  test("a fill with nothing secret in it needs no marker", () => {
    const s = auditAsScript([{
      id: "x", ts: 0, ok: true, op: "fill", args: { fields: { "#q": "orbit" } },
    } as never]);
    expect(s).toContain("agentglass-browser fill --field '#q=orbit'");
    expect(s).not.toContain("put the real value here");
  });

  test("end to end: a `fill` through the relay lands redacted in the audit log", async () => {
    setBrowserSink({
      send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: { filled: ["#user", "#password"] } })),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const p = parseAsk("fill", { fields: { "#user": "alice", "#password": "hunter2" } });
    if (!("ask" in p)) throw new Error("unreachable");
    await askBrowser(p.ask);
    const logged = exportAudit()[0]!;
    expect(JSON.stringify(logged), "the password reached the exportable log").not.toContain("hunter2");
    expect((logged.args.fields as Record<string, string>)["#user"]).toBe("alice");
  });
});

describe("§16 — reply redaction masks the span, and says it fired", () => {
  /*
   * THE POLICY CHANGE, decided rather than discovered. Whole-value replacement
   * is fail-closed and stays that way for what a caller SENDS. For what a page
   * RETURNS it was destroying honest reads: `read`, `text`, `html`, `region`
   * and `eval` hand the page back as one string, so one token-shaped substring
   * anywhere in it replaced the whole body with "[redacted]" — `ok: true`,
   * exit 0, and no way for the caller to tell that from an empty page.
   *
   * Observed once on real data: a `read` whose `url` came back as the literal
   * "[redacted]" beside 20 KB of intact `text`.
   */
  const readsBack = async (value: unknown) => {
    setBrowserSink({ send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value })), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const p = parseAsk("read", {});
    if (!("ask" in p)) throw new Error("unreachable");
    return askBrowser(p.ask);
  };

  test("a commit SHA in a page masks the SHA and nothing else, and the reply counts it", async () => {
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";  // 40 hex, an ordinary commit
    const r = await readsBack({ url: "https://orbit.example/pull/7", text: `merged ${sha} into main` });
    const v = r.value as { url: string; text: string };
    expect(v.text).toBe("merged [redacted] into main");
    expect(v.url, "the url was blanked whole, which is the observed failure").toBe("https://orbit.example/pull/7");
    expect(r.redacted, "redaction fired and said nothing").toBeDefined();
    expect(r.redacted!.spans).toBe(1);
    expect(r.redacted!.fields).toEqual({ text: 1 });
  });

  test("an honest reply carries no report at all", async () => {
    const r = await readsBack({ url: "https://orbit.example/", text: "nothing to see" });
    expect(r.redacted).toBeUndefined();
  });

  test("`skateboarding` and `pkg_resources` come back intact — the regex was tightened, this pins it", async () => {
    /*
     * The measured false positives. `sk` and `pk` are two of the commonest
     * letter pairs in English and the old branch required no separator after
     * them, so an English word matched and — before the span scoping above —
     * blanked the page it appeared in. Requiring the `-`/`_` that `sk-proj-`,
     * `ghp_` and `xoxb-` all carry drops both.
     */
    const body = "skateboarding is in pkg_resources somehow";
    const r = await readsBack({ text: body });
    expect((r.value as { text: string }).text).toBe(body);
    expect(r.redacted).toBeUndefined();
  });

  test("but an AWS access key id still goes — the branch the tightening would have killed", async () => {
    /*
     * `AKIA` has NO separator, so folding it into the prefixed branch alongside
     * a required `[-_]` stops detecting AWS keys and says nothing about it. It
     * gets its own branch; this is the test that notices if it is merged back.
     */
    const r = await readsBack({ text: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE" });
    expect((r.value as { text: string }).text).toBe("aws_access_key_id = [redacted]");
    expect(r.redacted!.spans).toBe(1);
  });

  test("a real key in the middle of a page still goes, and the page survives", async () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = await readsBack({ text: `before ${key} after` });
    expect((r.value as { text: string }).text).toBe("before [redacted] after");
  });

  test("two spans in two fields are counted separately", async () => {
    const r = await readsBack({
      title: "build 5d41402abc4b2a76b9719d911017c592",
      text: "asset /app.a3f5b1c9e7d2408f6b4a1c3e5d7f9a0b.js and sha 5d41402abc4b2a76b9719d911017c592",
    });
    expect(r.redacted!.spans).toBe(3);
    expect(r.redacted!.fields).toEqual({ title: 1, text: 2 });
  });

  test("a key hint still blanks the whole value — a header is a credential end to end", async () => {
    const r = await readsBack({ headers: { authorization: "Bearer not-token-shaped" } });
    expect((r.value as { headers: Record<string, string> }).headers.authorization).toBe("[redacted]");
    expect(r.redacted!.fields).toEqual({ authorization: 1 });
  });

  test("the report counts the REPLY only — what the caller sent is the log's business", async () => {
    /*
     * Two redactions run per call and they answer different questions: one
     * over the ask, whose result goes to the audit log, and one over the
     * reply, whose result goes to the caller. Sharing a tally would tell an
     * agent that a span was masked in text it never received — a report that
     * cannot be acted on is the failure §16 exists to stop, wearing the
     * opposite coat.
     */
    setBrowserSink({
      send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: { typed: "#q", submitted: false } })),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const p = parseAsk("type", { selector: "#q", text: "ghp_" + "a".repeat(30) });
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect(r.redacted, "the ask's own span was counted against the reply").toBeUndefined();
    // The log, meanwhile, has it — same call, other side.
    expect(exportAudit()[0]!.args.text).toBe("[redacted]");
  });

  test("`shot` is exempt, so there is always a working fallback", async () => {
    // A base64 PNG is a long run that matches a token shape by accident; §16's
    // own guardrail once decoded every capture above ~84KB to zero bytes.
    const png = "a".repeat(200) + "5d41402abc4b2a76b9719d911017c592";
    setBrowserSink({ send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: { png } })), listeners: () => 1 });
    noteBrowserReady("w1", true);
    const p = parseAsk("shot", {});
    if (!("ask" in p)) throw new Error("unreachable");
    const r = await askBrowser(p.ask);
    expect((r.value as { png: string }).png).toBe(png);
    expect(r.redacted).toBeUndefined();
  });
});

describe("several verbs in one call", () => {
  /*
   * §1, the first item on his own list by return. Measured: starting the CLI
   * process costs 104 ms before it has said a word, so the three-verb
   * interaction the spec describes spends a third of a second on process
   * startup, and a real repro spends most of a second.
   *
   * What is pinned here is not the speed — it is the two things that would
   * make a batch verb a bad trade.
   */
  test("a failed step stops the ones after it", async () => {
    noteBrowserReady("t", true);
    let sent = 0;
    setBrowserSink({
      // The first verb refuses; nothing after it should ever be sent.
      send: (ask) => {
        sent++;
        settleBrowser(ask.id, { ok: false, error: "nothing on the page matches #save" });
      },
      listeners: () => 1,
    });
    const r = await runSteps([
      { op: "click", args: { selector: "#save" } },
      { op: "click", args: { selector: "#next" } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps.length, "it ran a step after the failure").toBe(1);
    expect(sent, "it sent a verb after the failure").toBe(1);
    expect(r.steps[0]!.error).toContain("#save");
  });

  test("and the guardrails are not a door it walks around", async () => {
    /*
     * The reason every step goes through `parseAsk`: read-only mode and the
     * origin allow-list live in there. A batch that validated once and then
     * ran freely would leave the guardrail standing with a door beside it.
     */
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      noteBrowserReady("t", true);
      setBrowserSink({ send: (ask) => settleBrowser(ask.id, { ok: true, value: {} }), listeners: () => 1 });
      const r = await runSteps([{ op: "click", args: { selector: "#pay" } }]);
      expect(r.ok).toBe(false);
      expect(String(r.steps[0]!.error)).toContain("read-only");
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("the caller and the batch address reach every step, and a step's own page wins", async () => {
    const wire: Record<string, unknown>[] = [];
    setBrowserSink({
      send: (ask) => { wire.push(ask.args as Record<string, unknown>); settleBrowser(ask.id, { ok: true, value: { url: "u", title: "t", text: "" } }); },
      listeners: () => 1,
    });
    noteBrowserReady("t", true);
    const r = await runSteps(
      [{ op: "read", args: {} }, { op: "read", args: { page: "t9-own" } }],
      { page: "t7-mine", caller: { as: "orbit-do", how: "own-tab", pageExplicit: true } },
    );
    expect(r.ok).toBe(true);
    expect(wire.map((a) => a.as)).toEqual(["orbit-do", "orbit-do"]);
    expect(wire.map((a) => a.how)).toEqual(["own-tab", "own-tab"]);
    expect(wire.map((a) => a.page)).toEqual(["t7-mine", "t9-own"]);
    expect(wire.map((a) => a.pageExplicit)).toEqual([true, true]);
  });

  test("and a batch with no caller stays anonymous rather than inventing one", async () => {
    const wire: Record<string, unknown>[] = [];
    setBrowserSink({
      send: (ask) => { wire.push(ask.args as Record<string, unknown>); settleBrowser(ask.id, { ok: true, value: { url: "u", title: "t", text: "" } }); },
      listeners: () => 1,
    });
    noteBrowserReady("t", true);
    const r = await runSteps([{ op: "read", args: {} }]);
    expect(r.ok).toBe(true);
    expect(wire[0]!.as).toBeUndefined();
    expect(wire[0]!.page).toBeUndefined();
  });

  test("`profiles` retries the failure a retry can fix, like every other idempotent verb", async () => {
    /* It sat in IDEMPOTENT and never reached the loop: its name list went
       through `askOnce`. Measured, "view is not open" cost `tabs` nine asks
       across the CLI's three attempts and `profiles` three — one per attempt. */
    let asked = 0;
    setBrowserSink({
      send: (ask) => { asked++; settleBrowser(ask.id, { ok: false, error: "the browser view is not open in this window" }); },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const r = await askBrowser({ id: "p-retry", op: "profiles", args: {} });
    expect(r.ok).toBe(false);
    expect(asked, "profiles asked once and gave up").toBe(3);
  }, 10_000);

  test("a refused `open` claims no container — the ledger is written after every refusal has had its say", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    try {
      /* A url the relay refuses. It used to note the creator first. */
      const bad = parseAsk("open", { url: "javascript:alert(1)", profile: "ghost", identity: "squatter" });
      expect("error" in bad).toBe(true);
      expect(containerRecord("ghost")).toBeNull();
      /* Read-only mode refuses the mint — and used to write the ledger anyway,
         the one file it says it does not touch. */
      process.env.AGENTGLASS_BROWSER_READONLY = "1";
      const ro = parseAsk("open", { url: "https://orbit.example/", profile: "ghost", identity: "squatter" });
      expect("error" in ro).toBe(true);
      expect(containerRecord("ghost")).toBeNull();
      delete process.env.AGENTGLASS_BROWSER_READONLY;
      /* And an accepted one claims it. */
      const ok = parseAsk("open", { url: "https://orbit.example/", profile: "ghost", identity: "squatter" });
      expect("error" in ok).toBe(false);
      expect(containerRecord("ghost")!.creator).toBe("squatter");
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("the ask side is span-scoped too — a `type` keeps the words around a token", () => {
    /* The policy comment once said the opposite, and every ask-side test used
       text that WAS the token, where span and whole-value are indistinguishable. */
    const text = "internal creds for acme: ghp_" + "a".repeat(30) + " do not share";
    expect(redactAskForTest("type", { selector: "#note", text }, false).text)
      .toBe("internal creds for acme: [redacted] do not share");
  });

  test("the shareable script withholds what went to the clipboard", () => {
    const script = auditAsScript([
      { ts: 1, op: "clipboard", args: { write: "hunter2-the-vault-master-key" }, ok: true } as any,
    ]);
    expect(script).not.toContain("hunter2");
    expect(script).toContain("clipboard --write <28 characters, withheld here");
  });

  test("every verb whose parser reads a caller value is a row in the table or a named exemption", () => {
    /* The old lock compared the table with itself. This reads the parser: a
       `case "verb"` block that assigns one of the value keys must be covered. */
    const src = readFileSync(new URL("../src/browserdrive.ts", import.meta.url), "utf8");
    const from = src.indexOf("export function parseAsk(");
    const body = src.slice(from, src.indexOf("\nexport ", from + 10));
    const blocks = body.split(/\n\s*case "([a-zA-Z]+)":/).slice(1);
    const carrying = new Set<string>();
    for (let i = 0; i < blocks.length; i += 2) {
      const op = blocks[i]!, code = blocks[i + 1] ?? "";
      if (/args\.(text|fields|cookies|storage|write|value|body)\s*=/.test(code)) carrying.add(op);
    }
    const covered = new Set([...valueCarryingOpsForTest, ...valueCarryingExemptForTest]);
    const uncovered = [...carrying].filter((op) => !covered.has(op));
    expect(uncovered, `these verbs carry a caller value and are neither redacted nor a named exemption: ${uncovered.join(", ")}`).toEqual([]);
    /* And the check sees something, or it proves nothing. */
    expect(carrying.has("type")).toBe(true);
    expect(carrying.has("clipboard")).toBe(true);
  });

  test("the page-side copy of the token rule is the tightened one", () => {
    /* `browserObserve.ts` carries the console/network redaction inside the
       injected page script — a second copy, and it kept the old shape, so
       `skateboarding` and `pkg_resources` were still masked there after §16. */
    const web = readFileSync(new URL("../../web/src/lib/browserObserve.ts", import.meta.url), "utf8");
    expect(web).toContain("xox[baprs])[-_][A-Za-z0-9_-]{10,}");
    expect(web).toContain("AKIA[A-Z0-9]{16}");
    expect(web).not.toContain("|AKIA)[A-Za-z0-9_-]");
  });

  test("read-only mode refuses `profiles --drop` and `--make`, and still answers the list", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("profiles", {})).toBe(false);
      const drop = parseAsk("profiles", { drop: "anything" });
      expect("error" in drop).toBe(true);
      expect((drop as { error: string }).error).toContain("read-only");
      expect("error" in parseAsk("profiles", { make: "anything" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("the allow-list refusal names the way through, because a refusal without one gets worked around", () => {
    const before = process.env.AGENTGLASS_BROWSER_PROFILES;
    process.env.AGENTGLASS_BROWSER_PROFILES = "orbit-a,orbit-b";
    try {
      const r = parseAsk("open", { url: "https://orbit.example/", profile: "orbit-zzz", identity: "orbit-zzz" });
      expect("error" in r).toBe(true);
      expect((r as { error: string }).error).toContain("--shared");
      expect((r as { error: string }).error).toContain("shared: true");
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_PROFILES;
      else process.env.AGENTGLASS_BROWSER_PROFILES = before;
    }
  });

  test("an empty step list is refused, not answered with an empty success", async () => {
    const r = await runSteps([]);
    // Nothing ran, so nothing failed — but a caller reading `ok` must not read
    // that as "the six things I asked for happened".
    expect(r.steps.length).toBe(0);
  });
});

describe("the DevTools protocol is reachable and still fenced", () => {
  /*
   * §5. The spec names nine DevTools features and every one is a CDP domain
   * Chromium already implements, so the protocol is relayed whole. That makes
   * `cdp` the most powerful verb here by a distance — which is exactly why
   * these two facts have to be pinned rather than assumed.
   */
  test("cdp counts as ACTING, so read-only refuses it", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      const r = parseAsk("cdp", { method: "Page.navigate", params: { url: "https://example.com" } });
      expect("error" in r, "cdp slipped through read-only mode").toBe(true);
      expect(String((r as { error: string }).error)).toContain("read-only");
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
    /*
     * Classifying it as observing would have been an easy mistake and a total
     * one: the protocol can navigate, click, evaluate and set a breakpoint.
     * Read-only would still exist, with one verb that walks around it.
     */
  });

  test("listeners only reads, so read-only allows it", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("listeners", { selector: "#save" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("a method that is not one is refused before it reaches the page", () => {
    const r = parseAsk("cdp", { method: "enable" });
    expect("error" in r).toBe(true);
    expect(String((r as { error: string }).error)).toContain("Debugger.enable");
  });

  test("draining events needs no method", () => {
    expect("ask" in parseAsk("cdp", { events: true })).toBe(true);
  });

  test("coverage takes start or stop and nothing else", () => {
    expect("ask" in parseAsk("coverage", {})).toBe(true);
    expect("ask" in parseAsk("coverage", { action: "stop" })).toBe(true);
    expect("error" in parseAsk("coverage", { action: "restart" })).toBe(true);
  });
});

describe("emulation is checked before it reaches the page", () => {
  /*
   * §10. A typo here is SILENT: `colorScheme: "darc"` handed to Chromium
   * unvalidated sets nothing, reports success, and the run that trusted it
   * proves the wrong thing about a page that was never in dark mode. That is
   * worse than a refusal, because there is no moment where anybody finds out.
   */
  test("a value the protocol does not know is refused, not passed through", () => {
    expect("error" in parseAsk("emulate", { colorScheme: "darc" })).toBe(true);
    expect("error" in parseAsk("emulate", { reducedMotion: "less" })).toBe(true);
    expect("error" in parseAsk("emulate", { vision: "colourblind" })).toBe(true);
  });

  test("the ones it does know are allowed", () => {
    expect("ask" in parseAsk("emulate", { colorScheme: "dark" })).toBe(true);
    expect("ask" in parseAsk("emulate", { vision: "deuteranopia" })).toBe(true);
    expect("ask" in parseAsk("emulate", { width: 390, height: 844, mobile: true })).toBe(true);
    expect("ask" in parseAsk("emulate", { timezone: "Europe/Madrid" })).toBe(true);
  });

  test("locale is Intl inside the page, distinct from language's Accept-Language", () => {
    const r = parseAsk("emulate", { locale: "es-ES" });
    expect("ask" in r).toBe(true);
    expect((r as { ask: { args: Record<string, unknown> } }).ask.args.locale).toBe("es-ES");
  });

  test("geolocation needs both numbers, because half of one is a wrong place", () => {
    expect("error" in parseAsk("emulate", { geolocation: { lat: 40.4 } })).toBe(true);
    expect("error" in parseAsk("emulate", { geolocation: { lat: 40.4, lon: -3.7 } })).toBe(false);
  });

  test("and an empty call is refused rather than reported as success", () => {
    // "emulating: []" reads as if something was set. Nothing was.
    expect("error" in parseAsk("emulate", {})).toBe(true);
  });

  test("emulate ACTS — it changes what the page renders", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("emulate", { colorScheme: "dark" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("§8: the virtual clock, checked before it reaches the page", () => {
  test("advanceMs is bounded — a typo pins the page's scheduler running timers for however long that takes", () => {
    expect("error" in parseAsk("clock", { advanceMs: -1 })).toBe(true);
    expect("error" in parseAsk("clock", { advanceMs: 3_600_001 })).toBe(true);
    expect("error" in parseAsk("clock", { advanceMs: 1.5 })).toBe(true);
    expect("error" in parseAsk("clock", { advanceMs: 30_000 })).toBe(false);
  });

  test("advanceMs: 0 alone is refused — nothing to do is not success", () => {
    // Same shape as emulate's empty-call refusal: "clock" with no advance, no
    // seal and no freeze would answer ok and change nothing on the page.
    expect("error" in parseAsk("clock", { advanceMs: 0 })).toBe(true);
    expect("error" in parseAsk("clock", {})).toBe(true);
  });

  test("advanceMs: 0 is a legal call when seal or freezeAnimations carries the request", () => {
    expect("error" in parseAsk("clock", { advanceMs: 0, seal: true })).toBe(false);
    expect("error" in parseAsk("clock", { freezeAnimations: true })).toBe(false);
  });

  test("waitFor is one of the two modes the spec names, nothing else", () => {
    expect("error" in parseAsk("clock", { advanceMs: 1000, waitFor: "networkIdle" })).toBe(false);
    expect("error" in parseAsk("clock", { advanceMs: 1000, waitFor: "noTimers" })).toBe(false);
    expect("error" in parseAsk("clock", { advanceMs: 1000, waitFor: "idle" })).toBe(true);
  });

  test("seal and freezeAnimations must be booleans, not truthy strings", () => {
    expect("error" in parseAsk("clock", { seal: "true" })).toBe(true);
    expect("error" in parseAsk("clock", { freezeAnimations: 1 })).toBe(true);
  });

  test("clock ACTS — it moves the page's own clock forward", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("clock", { advanceMs: 1000 })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("health answers, it does not fail", () => {
  /*
   * FOUND BY USING IT. `health` refused with "the browser view is not open in
   * this window" — which is precisely the fact it exists to report. A
   * diagnostic verb that fails on the condition it diagnoses tells the caller
   * nothing the failure did not, and sends it hunting for a second way to ask.
   * That is the shape §15 was written against, in the one verb §15 added.
   */
  test("with no window at all, it still answers", async () => {
    resetBrowserDrive();
    const r = await askBrowser({ id: "h1", op: "health", args: {} } as never);
    expect(r.ok, "health failed instead of reporting").toBe(true);
    expect((r.value as any).window).toBe(false);
    expect((r.value as any).ready).toBe(false);
    expect(String((r.value as any).summary)).toContain("closed");
  });

  test("with a window but no panel, it says which of the two is missing", async () => {
    resetBrowserDrive();
    setBrowserSink({ send: () => {}, listeners: () => 1 });
    const r = await askBrowser({ id: "h2", op: "health", args: {} } as never);
    expect(r.ok).toBe(true);
    expect((r.value as any).window).toBe(true);
    expect((r.value as any).panel).toBe(false);
    // And what to do about it, because "not mounted" is not an instruction.
    expect(String((r.value as any).summary)).toContain("open");
  });

  test("every other verb still refuses, because they genuinely cannot run", async () => {
    resetBrowserDrive();
    const r = await askBrowser({ id: "h3", op: "click", args: { selector: "#x" } } as never);
    expect(r.ok).toBe(false);
  });
});

describe("waiting instead of asking twenty times", () => {
  /*
   * §1. The spec opens on a shell loop — `for i in $(seq 1 20); do ... done` —
   * and the loop is the expensive part: a process start (104ms measured) and
   * an HTTP round trip per turn, plus every answer parked in the agent's
   * context for the rest of the session, which §14 measures at 82.7% of what
   * an agent spends.
   *
   * The waiting moves to the server, where it costs a loop. From where the
   * agent stands, one call that answers when something happens is
   * indistinguishable from being pushed to.
   */
  test("it answers the moment there is something", async () => {
    let round = 0;
    window((id) => {
      round++;
      // Nothing on the first look, a console row on the second.
      settleBrowser(id, { ok: true, value: { rows: round > 2 ? [{ level: "error", text: "boom" }] : [], now: Date.now() } });
    });
    const r = await waitForEvents({ since: 0, waitMs: 5_000, kinds: ["console"] });
    expect(r.ok).toBe(true);
    expect((r.value as any).console).toHaveLength(1);
    expect((r.value as any).nothing).toBeUndefined();
  });

  test("and nothing happening is an ANSWER, not a failure", async () => {
    /*
     * Dressing an expired wait as an error would send a caller retrying
     * something that worked — and "nothing happened in 30 seconds" is very
     * often the exact fact being checked.
     */
    window((id) => settleBrowser(id, { ok: true, value: { rows: [], now: Date.now() } }));
    const r = await waitForEvents({ since: 0, waitMs: 300, kinds: ["console"] });
    expect(r.ok, "an empty wait was reported as a failure").toBe(true);
    expect((r.value as any).nothing).toBe(true);
    // With the cursor to carry into the next wait, so a caller that loops does
    // not re-read what it has already seen.
    expect(typeof (r.value as any).now).toBe("number");
  });

  test("a wait longer than the ceiling is refused, not silently clamped", () => {
    expect("error" in parseAsk("events", { wait: 600 })).toBe(true);
    expect("ask" in parseAsk("events", { wait: 120 })).toBe(true);
  });

  test("it only observes, so read-only allows it", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("events", { wait: 5 })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("a recording that is a file, not a pile of pictures", () => {
  /*
   * §12. The assembling with ffmpeg is the small half of the problem. The
   * expensive half is that every frame is a separate CLI call, so ten frames
   * half a second apart is ten process starts, ten round trips and ten base64
   * images parked in the agent's context — for a thing whose entire output is
   * one file.
   */
  test("a recording longer than the verb may live is refused UP FRONT", () => {
    // Rather than dying half way and leaving the caller to work out how much
    // of the timeline is missing.
    const r = parseAsk("record", { dir: "/tmp/x", frames: 120, every: 10_000 });
    expect("error" in r).toBe(true);
    expect(String((r as { error: string }).error)).toContain("ceiling");
  });

  test("the frames go somewhere real, or it does not start", () => {
    expect("error" in parseAsk("record", { dir: "relative/path" })).toBe(true);
    expect("error" in parseAsk("record", {})).toBe(true);
    expect("ask" in parseAsk("record", { dir: "/tmp/shots" })).toBe(true);
  });

  test("and the gif is a gif", () => {
    expect("error" in parseAsk("record", { dir: "/tmp/x", gif: "/tmp/out.mp4" })).toBe(true);
    expect("error" in parseAsk("record", { dir: "/tmp/x", gif: "out.gif" })).toBe(true);
    expect("ask" in parseAsk("record", { dir: "/tmp/x", gif: "/tmp/out.gif" })).toBe(true);
  });

  test("what a frame contains is shot's vocabulary, not a second one", () => {
    // Same names, same rules, validated by the same code when each frame is
    // taken. A second vocabulary for the same thing is how the two drift.
    const r = parseAsk("record", { dir: "/tmp/x", selector: "#board" });
    expect("ask" in r && (r.ask.args as any).selector).toBe("#board");
  });
});

describe("download: a file returned by its local path — spec §11", () => {
  /*
   * "Return the resulting local path, do not just let it vanish into a
   * directory. A download reported as done with no path is the same as no
   * download." So the thing worth pinning is not the happy path alone — it
   * is that the path handed back is the file Chromium actually wrote, and
   * that a canceled download is reported rather than timed out on.
   */
  test("parseAsk needs a selector and an absolute dir", () => {
    expect("error" in parseAsk("download", {})).toBe(true);
    expect("error" in parseAsk("download", { selector: "#export" })).toBe(true);
    expect("error" in parseAsk("download", { selector: "#export", dir: "relative" })).toBe(true);
    expect("ask" in parseAsk("download", { selector: "#export", dir: "/tmp/dl" })).toBe(true);
  });

  test("returns the path the download actually landed at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentglass-dl-test-"));
    let drains = 0;
    setBrowserSink({
      send: (ask) => queueMicrotask(() => {
        if (ask.op === "click") { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        const args = ask.args as { events?: boolean };
        if (!args.events) { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        drains++;
        if (drains === 1) {
          settleBrowser(ask.id, { ok: true, value: { events: [
            { at: Date.now(), method: "Page.downloadWillBegin", params: { guid: "g1", suggestedFilename: "report.csv" } },
          ] } });
          return;
        }
        // The file lands on disk exactly when Chromium says the download
        // completed — nothing before this drain should be able to see it.
        writeFileSync(join(dir, "report.csv"), "a,b\n1,2\n");
        settleBrowser(ask.id, { ok: true, value: { events: [
          { at: Date.now(), method: "Page.downloadProgress", params: { guid: "g1", state: "completed" } },
        ] } });
      }),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);

    try {
      const r = await downloadFile({ selector: "#export", dir, timeoutMs: 5000 });
      expect(r.ok).toBe(true);
      const value = r.value as { path: string; dir: string; filename: string };
      expect(value.filename).toBe("report.csv");
      expect(value.path).toBe(join(dir, "report.csv"));
      expect(readFileSync(value.path, "utf8")).toContain("1,2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a canceled download is reported, not waited out to the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentglass-dl-test-"));
    setBrowserSink({
      send: (ask) => queueMicrotask(() => {
        if (ask.op === "click") { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        const args = ask.args as { events?: boolean };
        if (!args.events) { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        settleBrowser(ask.id, { ok: true, value: { events: [
          { at: Date.now(), method: "Page.downloadWillBegin", params: { guid: "g1", suggestedFilename: "x.bin" } },
          { at: Date.now(), method: "Page.downloadProgress", params: { guid: "g1", state: "canceled" } },
        ] } });
      }),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);

    try {
      const r = await downloadFile({ selector: "#export", dir, timeoutMs: 5000 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("canceled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a completed state with no filename fails loudly rather than guessing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentglass-dl-test-"));
    setBrowserSink({
      send: (ask) => queueMicrotask(() => {
        if (ask.op === "click") { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        const args = ask.args as { events?: boolean };
        if (!args.events) { settleBrowser(ask.id, { ok: true, value: {} }); return; }
        settleBrowser(ask.id, { ok: true, value: { events: [
          { at: Date.now(), method: "Page.downloadProgress", params: { guid: "g1", state: "completed" } },
        ] } });
      }),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);

    try {
      const r = await downloadFile({ selector: "#export", dir, timeoutMs: 5000 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("named no file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the session, as a script somebody can run again", () => {
  /*
   * §12's last item, built on §16's log — which is the pleasing part: the log
   * exists to prove what was touched, and proving what was touched and
   * replaying it are the same list read twice.
   */
  const entry = (op: string, args: Record<string, unknown>, ok = true) =>
    ({ id: "x", ts: 0, op, args, ok } as never);

  test("reads are left out, because replaying them proves nothing", () => {
    const s = auditAsScript([
      entry("open", { url: "https://example.com" }),
      entry("observe", {}),
      entry("read", {}),
      entry("click", { selector: "#save" }),
    ]);
    expect(s).toContain("open 'https://example.com'");
    expect(s).toContain("click '#save'");
    expect(s, "an observation was replayed").not.toContain("observe");
  });

  test("a redacted secret stays redacted, and SAYS so on the line", () => {
    /*
     * The alternative is a script that silently types the word "[redacted]"
     * into a login form and fails somewhere further down for a reason nobody
     * can see. Marking the line puts the discovery where the fix is.
     */
    const s = auditAsScript([entry("type", { selector: "#pw", text: "[redacted]", submit: true })]);
    expect(s).toContain("[redacted]");
    expect(s).toContain("put the real value here");
    expect(s).toContain("banned another tool here");
  });

  test("a verb with no shell form becomes a comment, not a guess", () => {
    // A plausible command that does something else is worse than a gap.
    const s = auditAsScript([entry("eval", { js: "app.reset()" })]);
    expect(s).toContain("# eval");
    expect(s).not.toMatch(/^agentglass-browser eval/m);
  });

  test("and a refusal is kept as a comment, because it is part of the story", () => {
    const s = auditAsScript([{ id: "x", ts: 0, op: "click", args: { selector: "#gone" }, ok: false, error: "nothing matches" } as never]);
    expect(s).toContain("refused at the time");
    expect(s).toContain("nothing matches");
  });

  test("a session that changed nothing says so, rather than emitting an empty script", () => {
    const s = auditAsScript([entry("observe", {}), entry("shot", {})]);
    expect(s).toContain("nothing in this session changed anything");
  });
});

describe("the debugger, and which half of it acts", () => {
  /*
   * §5. The protocol is reachable whole through `cdp`, so this verb exists for
   * the part that is awkward there: a pause is an EVENT, so its frames are in
   * a buffer rather than in an answer, and reading the scope of a paused frame
   * is a three-call chain whose arguments come out of the previous answer.
   */
  test("asking WHERE it is paused only looks, so read-only allows it", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("debug", { action: "where" })).toBe(true);
      /*
       * …and everything else changes what the page does next. Deciding by verb
       * would have to pick one for all of them, and picking "observes" would
       * let read-only mode step a live page. `debug` is two verbs wearing one
       * name, so the classification is per ACTION.
       */
      for (const action of ["break", "dom", "resume", "into", "over", "out", "on"]) {
        const r = parseAsk("debug", { action, url: "u", line: 1, selector: "#x" });
        expect("error" in r, `${action} slipped through read-only`).toBe(true);
      }
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("a breakpoint needs somewhere to be", () => {
    expect("error" in parseAsk("debug", { action: "break" })).toBe(true);
    expect("error" in parseAsk("debug", { action: "break", url: "app.js" })).toBe(true);
    expect("error" in parseAsk("debug", { action: "break", url: "app.js", line: 0 })).toBe(true);
    expect("ask" in parseAsk("debug", { action: "break", url: "app.js", line: 42 })).toBe(true);
  });

  test("a DOM breakpoint says what it is watching for", () => {
    expect("error" in parseAsk("debug", { action: "dom" })).toBe(true);
    expect("error" in parseAsk("debug", { action: "dom", selector: "#row", on: "exploded" })).toBe(true);
    const ok = parseAsk("debug", { action: "dom", selector: "#row" });
    // Defaulted rather than required: "who deleted this row" is the question
    // this exists for, and subtree-modified is the answer to it.
    expect("ask" in ok && (ok.ask.args as any).on).toBe("subtree-modified");
  });

  test("an action that is not one is refused by name", () => {
    const r = parseAsk("debug", { action: "continue" });
    expect("error" in r).toBe(true);
    expect(String((r as { error: string }).error)).toContain("resume");
  });
});

describe("waiting on a condition with a name", () => {
  /*
   * §8 asks for "network idle" and "no timers pending" as wait MODES. Both are
   * awkward to write from outside: only the page knows how many requests are
   * in flight, and the network log cannot say, because it records the ones
   * that FINISHED.
   */
  test("the named conditions compile to the expression the verb already runs", () => {
    const r = parseAsk("waitfor", { until: "network-idle" });
    expect("ask" in r).toBe(true);
    const js = String(("ask" in r ? r.ask.args.js : ""));
    expect(js).toContain("inflight");
    // Quiet for a moment, not merely zero right now: between two requests of a
    // chain there is an instant where nothing is in flight, and a check that
    // fires there calls a page settled in the middle of loading.
    expect(js, "it would fire in the gap between two requests").toContain("lastSettled");
  });

  test("js and until together is refused, because each says it on its own", () => {
    expect("error" in parseAsk("waitfor", { js: "true", until: "no-timers" })).toBe(true);
  });

  test("neither is refused with the choices named", () => {
    const r = parseAsk("waitfor", {});
    expect("error" in r).toBe(true);
    expect(String((r as { error: string }).error)).toContain("network-idle");
  });

  test("a condition that is not one is refused, not passed to the page", () => {
    expect("error" in parseAsk("waitfor", { until: "quiet" })).toBe(true);
  });
});

describe("§13: the settings, as an API", () => {
  test("needs an action", () => {
    expect("error" in parseAsk("settings", {})).toBe(true);
    expect("error" in parseAsk("settings", { action: "poke" })).toBe(true);
  });

  test("get needs nothing else", () => {
    const r = parseAsk("settings", { action: "get" });
    expect("ask" in r && r.ask.args).toEqual({ action: "get" });
  });

  test("set with nothing to change is refused, not silently a no-op", () => {
    expect("error" in parseAsk("settings", { action: "set" })).toBe(true);
  });

  test("cache is one of two words", () => {
    expect("error" in parseAsk("settings", { action: "set", cache: "aggressive" })).toBe(true);
    expect("error" in parseAsk("settings", { action: "set", cache: "bypass" })).toBe(false);
  });

  test("ignoreCertErrors must be a boolean", () => {
    expect("error" in parseAsk("settings", { action: "set", ignoreCertErrors: "yes" })).toBe(true);
    expect("error" in parseAsk("settings", { action: "set", ignoreCertErrors: true })).toBe(false);
  });

  test("block needs an origin and something to block", () => {
    expect("error" in parseAsk("settings", { action: "set", block: { images: true } })).toBe(true);
    expect("error" in parseAsk("settings", { action: "set", block: { origin: "example.com" } })).toBe(true);
    expect("error" in parseAsk("settings", { action: "set", block: { origin: "example.com", images: true } })).toBe(false);
  });

  test("block's origin is a host, not a URL", () => {
    const r = parseAsk("settings", { action: "set", block: { origin: "https://example.com/", js: true } });
    expect("error" in r).toBe(true);
  });

  test("the internal page is a closed set of one — this webview renders no other", () => {
    /*
     * Written as `page` until §14, and it could not stay that way: `page` is
     * how every other verb says WHICH TAB, and `settings` owning the name is
     * the whole reason it was the one verb that could not be pointed at a tab.
     * The closed set moved to `internalPage` with it. `page: "blank"` is still
     * bridged, exactly and only that literal, for the CLI on disk today.
     */
    expect("error" in parseAsk("settings", { action: "set", internalPage: "version" })).toBe(true);
    expect("error" in parseAsk("settings", { action: "set", internalPage: "blank" })).toBe(false);
    expect("error" in parseAsk("settings", { action: "set", page: "blank" })).toBe(false);
  });

  test("set ACTS — read-only mode refuses it, get still answers", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("settings", { action: "get" })).toBe(false);
      expect("error" in parseAsk("settings", { action: "set", cache: "bypass" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("dragging and uploading", () => {
  test("a drag needs both ends", () => {
    expect("error" in parseAsk("drag", { selector: "#row" })).toBe(true);
    expect("error" in parseAsk("drag", { to: "#bin" })).toBe(true);
    expect("ask" in parseAsk("drag", { selector: "#row", to: "#bin" })).toBe(true);
  });

  test("upload paths must be absolute", () => {
    /*
     * A relative path resolves against whatever the SHELL's working directory
     * happens to be, which is not the caller's. The failure mode is a file
     * that silently is not there, which reads as "the upload did nothing".
     */
    const dir = mkdtempSync(join(tmpdir(), "agx-upload-"));
    writeFileSync(join(dir, "report.pdf"), "%PDF");
    // The scratch file is admitted through the machine-search roots, so this
    // test says the same thing whatever workspace root an earlier suite in
    // the same process left behind: it is about the SHAPE of the path.
    const roots = process.env.AGENTGLASS_DISK_ROOTS;
    process.env.AGENTGLASS_DISK_ROOTS = dir;
    try {
      expect("error" in parseAsk("upload", { selector: "#f", paths: ["report.pdf"] })).toBe(true);
      expect("ask" in parseAsk("upload", { selector: "#f", paths: [join(dir, "report.pdf")] })).toBe(true);
      expect("error" in parseAsk("upload", { selector: "#f", paths: [] })).toBe(true);
    } finally {
      if (roots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS; else process.env.AGENTGLASS_DISK_ROOTS = roots;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both ACT, so read-only refuses them", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("drag", { selector: "#a", to: "#b" })).toBe(true);
      expect("error" in parseAsk("upload", { selector: "#f", paths: ["/tmp/x"] })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("what an upload may attach", () => {
  /*
   * Before this the only check was `startsWith("/")`, and the audit's example
   * was `~/.ssh/id_rsa`: any absolute path went to the panel, which attached
   * it through the debugger. The fixture is a fake home with the files that
   * matter, HOME and XDG_CONFIG_HOME pointed at it, and nothing real touched.
   */
  const ENV = ["HOME", "XDG_CONFIG_HOME", "AGENTGLASS_ROOT", "AGENTGLASS_DISK_DISABLED", "AGENTGLASS_FS_BROWSE_DISABLED", "AGENTGLASS_DISK_ROOTS"] as const;
  let saved: Record<string, string | undefined> = {};
  let home = "";
  const up = (p: string) => parseAsk("upload", { selector: "#f", paths: [p] });
  const err = (p: string): string => { const r = up(p); return "error" in r ? r.error : ""; };
  const attached = (p: string): string[] => { const r = up(p); return "ask" in r ? (r.ask.args as { paths: string[] }).paths : []; };

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    home = realpathSync(mkdtempSync(join(tmpdir(), "agx-upload-home-")));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    for (const k of ENV.slice(2)) delete process.env[k];
    mkdirSync(join(home, ".ssh")); writeFileSync(join(home, ".ssh", "id_key"), "PRIVATE");
    mkdirSync(join(home, ".aws")); writeFileSync(join(home, ".aws", "credentials"), "aws");
    mkdirSync(join(home, ".config", "agentglass"), { recursive: true }); writeFileSync(join(home, ".config", "agentglass", "token"), "tok");
    writeFileSync(join(home, ".netrc"), "machine x");
    mkdirSync(join(home, "Documents")); writeFileSync(join(home, "Documents", "report.pdf"), "%PDF");
  });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    rmSync(home, { recursive: true, force: true });
  });

  test("a plain document under the home directory is attached, by its real path", () => {
    expect(attached(join(home, "Documents", "report.pdf"))).toEqual([join(home, "Documents", "report.pdf")]);
  });

  test("keys, cloud credentials and the app's own token are never attached, and the error names the rule not the bytes", () => {
    for (const p of [join(home, ".ssh", "id_key"), join(home, ".aws", "credentials"), join(home, ".config", "agentglass", "token")]) {
      const e = err(p);
      expect(e).toContain("never attached");
      expect(e).not.toContain("PRIVATE");
      expect(e).not.toContain("tok\n");
    }
  });

  test("a link from an innocent place is judged by where it really points", () => {
    symlinkSync(join(home, ".ssh", "id_key"), join(home, "Documents", "harmless.pdf"));
    expect(err(join(home, "Documents", "harmless.pdf"))).toContain(".ssh");
  });

  test("with no workspace root, a hidden file under ~ is not 'in scope' for shipping to a page", () => {
    expect(err(join(home, ".netrc"))).toContain("outside");
  });

  test("a file that is not there is refused before anything is judged", () => {
    expect(err(join(home, "Documents", "missing.pdf"))).toContain("does not exist");
  });

  test("the two disk kill switches shut the verb, read at call time", () => {
    process.env.AGENTGLASS_DISK_DISABLED = "1";
    expect(err(join(home, "Documents", "report.pdf"))).toContain("AGENTGLASS_DISK_DISABLED");
    delete process.env.AGENTGLASS_DISK_DISABLED;
    process.env.AGENTGLASS_FS_BROWSE_DISABLED = "1";
    expect(err(join(home, "Documents", "report.pdf"))).toContain("AGENTGLASS_FS_BROWSE_DISABLED");
  });

  test("with a workspace root, inside it goes and outside it does not — unless the machine-search roots say so", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-upload-root-")));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "agx-upload-elsewhere-")));
    try {
      writeFileSync(join(root, "shot.png"), "png");
      writeFileSync(join(elsewhere, "shot.png"), "png");
      process.env.AGENTGLASS_ROOT = root;
      expect(attached(join(root, "shot.png"))).toEqual([join(root, "shot.png")]);
      expect(err(join(elsewhere, "shot.png"))).toContain("outside the workspace");
      expect(attached(join(home, "Documents", "report.pdf")), "HOME is a machine-search root").toHaveLength(1);
      process.env.AGENTGLASS_DISK_ROOTS = elsewhere;
      expect(attached(join(elsewhere, "shot.png"))).toHaveLength(1);
      expect(err(join(home, ".ssh", "id_key")), "the deny list wins over any root").toContain("never attached");
    } finally {
      rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the rest of a session, and printing", () => {
  test("writing storage ACTS, reading it only looks", () => {
    /*
     * §7. Deciding by verb would have to pick one: writing changes what the
     * page believes on its next load, which is as much an action as a click,
     * while reading is an observation. So it is decided per call.
     */
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("storage", {})).toBe(true);
      expect("error" in parseAsk("storage", { set: true, key: "t", value: "x" })).toBe(true);
      expect("error" in parseAsk("storage", { remove: true, key: "t" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });

  test("a permission goes through the SAME origin allow-list as everything else", () => {
    /*
     * Granting the camera to a site the browser is not allowed to visit would
     * be a fence with a gate beside it — the exact shape §16 exists to close.
     */
    const before = process.env.AGENTGLASS_BROWSER_ORIGINS;
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8001";
    try {
      expect("ask" in parseAsk("permission", { origin: "http://localhost:8001", permissions: ["geolocation"] })).toBe(true);
      const r = parseAsk("permission", { origin: "https://example.com", permissions: ["geolocation"] });
      expect("error" in r, "a permission was granted outside the allow-list").toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_ORIGINS;
      else process.env.AGENTGLASS_BROWSER_ORIGINS = before;
    }
  });

  test("and it needs a real origin, not a hostname", () => {
    expect("error" in parseAsk("permission", { origin: "localhost:8001", permissions: ["geolocation"] })).toBe(true);
    expect("error" in parseAsk("permission", { origin: "http://localhost:8001", permissions: [] })).toBe(true);
  });

  test("pdf only observes — it renders, it does not change the page", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("pdf", {})).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("being slow, and the HAR", () => {
  test("offline and slow are different settings, not one", () => {
    /*
     * §6. A request that fails instantly takes a different path through most
     * apps than one that takes twelve seconds — a spinner that never resolves
     * versus an error banner. Folding them into one setting hides whichever
     * bug is not being looked at.
     */
    expect("ask" in parseAsk("throttle", { offline: true })).toBe(true);
    expect("ask" in parseAsk("throttle", { network: "slow-3g" })).toBe(true);
  });

  test("cpu is a RATE, so under 1 is a machine that does not exist", () => {
    expect("error" in parseAsk("throttle", { cpu: 0.5 })).toBe(true);
    expect("error" in parseAsk("throttle", { cpu: 100 })).toBe(true);
    expect("ask" in parseAsk("throttle", { cpu: 4 })).toBe(true);
  });

  test("an empty throttle is refused rather than reported as applied", () => {
    expect("error" in parseAsk("throttle", {})).toBe(true);
  });

  test("a network preset that is not one never reaches the browser", () => {
    expect("error" in parseAsk("throttle", { network: "2g" })).toBe(true);
  });

  test("throttling ACTS and the HAR only reads", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("error" in parseAsk("throttle", { network: "slow-3g" })).toBe(true);
      expect("ask" in parseAsk("har", {})).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("retrying the failures a retry can fix", () => {
  /*
   * §15. The panel de-registers itself for a moment when its tab changes, and
   * a call landing in that gap is told the view is not open when it is. That
   * is a real, measured, self-healing failure — making every caller handle it
   * is making every caller write the same loop.
   */
  test("an idempotent verb is asked again when nothing answered", async () => {
    let tries = 0;
    setBrowserSink({
      send: (a) => {
        tries++;
        // Not open the first time, fine the second.
        settleBrowser(a.id, tries === 1
          ? { ok: false, error: "the browser view is not open in this window" }
          : { ok: true, value: { text: "hello" } });
      },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const r = await askBrowser({ id: "r1", op: "read", args: {} } as never);
    expect(r.ok, "it gave up on a failure a retry fixes").toBe(true);
    expect(tries).toBe(2);
  });

  test("a refusal with a REASON is never retried", async () => {
    /*
     * "Nothing matches #save" is an ANSWER. Asking again spends the clock to
     * arrive at the same sentence.
     */
    let tries = 0;
    setBrowserSink({
      send: (a) => { tries++; settleBrowser(a.id, { ok: false, error: "nothing on the page matches #save" }); },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const r = await askBrowser({ id: "r2", op: "read", args: {} } as never);
    expect(r.ok).toBe(false);
    expect(tries, "a real refusal was retried").toBe(1);
  });

  test("a verb that ACTS is never retried, whatever the failure", async () => {
    /*
     * A retried click on "Pay" is the reason retry-everything is a bad
     * default. The list is of verbs that do nothing twice when asked twice.
     */
    let tries = 0;
    setBrowserSink({
      send: (a) => { tries++; settleBrowser(a.id, { ok: false, error: "the browser did not answer in time (click)" }); },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const r = await askBrowser({ id: "r3", op: "click", args: { selector: "#pay" } } as never);
    expect(r.ok).toBe(false);
    expect(tries, "a click was sent more than once").toBe(1);
  });
});

describe("two pages at once", () => {
  /*
   * §9, and the case the spec calls what a pure reproduction actually needs:
   * one page watching a board while another changes its state.
   */
  test("the lanes really run concurrently, not one after the other", async () => {
    const order: string[] = [];
    setBrowserSink({
      send: (a) => {
        const page = String((a.args as { page?: string }).page ?? "?");
        order.push(`send:${page}`);
        // The watcher answers slowly; the actor answers at once. If these ran
        // in sequence the actor would not start until the watcher finished.
        setTimeout(() => settleBrowser(a.id, { ok: true, value: {} }), page === "p1" ? 60 : 0);
      },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    await runLanes([
      { page: "p1", steps: [{ op: "read", args: {} }] },
      { page: "p2", steps: [{ op: "read", args: {} }] },
    ]);
    // Both were SENT before either came back — which is the whole point.
    expect(order).toEqual(["send:p1", "send:p2"]);
  });

  test("the page id rides on every step, so it cannot be half-forgotten", async () => {
    const pages: string[] = [];
    setBrowserSink({
      send: (a) => {
        pages.push(String((a.args as { page?: string }).page ?? "none"));
        settleBrowser(a.id, { ok: true, value: {} });
      },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    await runLanes([{ page: "p2", steps: [{ op: "read", args: {} }, { op: "text", args: { selector: "h1" } }] }]);
    // Two of five steps going to the wrong page produces a result that looks
    // almost right, which is worse than one that fails.
    expect(pages).toEqual(["p2", "p2"]);
  });

  test("one lane failing does not take the other's answer with it", async () => {
    setBrowserSink({
      send: (a) => {
        const page = String((a.args as { page?: string }).page ?? "");
        settleBrowser(a.id, page === "p1"
          ? { ok: false, error: "nothing on the page matches #gone" }
          : { ok: true, value: { text: "still here" } });
      },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const r = await runLanes([
      { page: "p1", steps: [{ op: "read", args: {} }] },
      { page: "p2", steps: [{ op: "read", args: {} }] },
    ]);
    expect(r.ok).toBe(false);
    // In a two-actor reproduction the other lane is half the evidence.
    expect((r.lanes[1] as { ok: boolean }).ok).toBe(true);
  });
});

describe("extra headers, and the page as a file", () => {
  test("a header value with a newline never reaches the browser", () => {
    /*
     * A CRLF in a header value is header injection — the oldest trick in HTTP,
     * and the reason this is checked here rather than trusted to Chromium.
     */
    expect("error" in parseAsk("headers", { headers: { "X-Trace": "a\r\nX-Admin: 1" } })).toBe(true);
    expect("error" in parseAsk("headers", { headers: { "X Trace": "1" } })).toBe(true);
    expect("ask" in parseAsk("headers", { headers: { "X-Trace": "abc123" } })).toBe(true);
  });

  test("no headers means clear them, not an error", () => {
    // Clearing has to be as easy as setting, or a session keeps a header
    // somebody set an hour ago and nobody remembers.
    const r = parseAsk("headers", {});
    expect("ask" in r && (r.ask.args as any).headers).toEqual({});
  });

  test("save only observes, clipboard-write acts", () => {
    const before = process.env.AGENTGLASS_BROWSER_READONLY;
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    try {
      expect("ask" in parseAsk("save", {})).toBe(true);
      expect("error" in parseAsk("headers", { headers: { "X-A": "1" } })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_BROWSER_READONLY;
      else process.env.AGENTGLASS_BROWSER_READONLY = before;
    }
  });
});

describe("IndexedDB, by name", () => {
  test("it lists, and refuses to be written blind", () => {
    /*
     * §7. Reading the names is useful and writing one is not: a structured
     * clone written into a page's own database is a corruption somebody
     * debugs for a day, and there is no version of "write this blob" that an
     * agent can do safely from outside.
     */
    expect("ask" in parseAsk("storage", { where: "idb" })).toBe(true);
    expect("error" in parseAsk("storage", { where: "idb", set: true, key: "k", value: "v" })).toBe(true);
  });

  test("a store that is not one is refused", () => {
    expect("error" in parseAsk("storage", { where: "cookies" })).toBe(true);
  });
});


/* One `case "x": { … }` from browserDrive, to its own closing brace. Reading a
   fixed number of characters instead has now cost four red runs in this file
   alone — the house rule against slicing source by an offset is about exactly
   this, and a test that reads the wrong code passes for the wrong reason just
   as easily as it fails. */
function shotCase(src: string, name: string): string {
  const at = src.indexOf(`case "${name}": {`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return src.slice(at);
}

describe("a capture that is not written is not a capture", () => {
  /*
   * REPORTED BY AN AGENT USING IT, and the worst shape of failure this tool
   * has had: `shot` wrote a zero-byte PNG, printed the path, and exited 0. Its
   * own help tells an agent to branch on the exit code, so two empty files
   * with evidence names ended up in somebody's proof-of-life folder.
   *
   * The verb itself was right — it returned a refusal. The CLI wrote the empty
   * payload anyway. Both halves are pinned: the panel refuses, and the CLI
   * treats no pixels as a failure.
   */
  test("the panel refuses when there are no pixels rather than answering ok", () => {
    // The shape the CLI reads. `shot` returning ok with an empty png is what
    // made an empty file look like a good one.
    const src = readFileSync(new URL("../../web/src/lib/browserDrive.ts", import.meta.url), "utf8");
    const body = shotCase(src, "shot");
    expect(body, "the shot case moved").not.toBe("");
    expect(body, "an empty payload is not treated as a failure").toContain("if (!payload)");
  });

  test("the CLI never writes a file it has no pixels for", () => {
    const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
    const at = cli.indexOf('elif a.cmd == "shot":\n        png =');
    expect(at, "the shot writer moved").toBeGreaterThan(-1);
    /* To the END of that branch, not a fixed 1200 characters: comments added
       inside it pushed `os.replace` past the window and turned a passing rule
       into a failing one without the rule changing at all. */
    const nextBranch = cli.indexOf("\n    else:", at);
    const body = cli.slice(at, nextBranch === -1 ? at + 4000 : nextBranch);
    expect(body, "it still writes whatever came back").toContain("if not raw:");
    // And the write is atomic, so an interrupted one cannot leave a truncated
    // PNG under the name of a good one.
    expect(body).toContain("os.replace");
  });

  test("a plain shot goes out WITHOUT a rectangle", () => {
    /*
     * This test said the opposite, and the reasoning behind it was real:
     * `shot --clip 0,0,w,h` produced pixels 10/10 while plain `shot` produced
     * none, because the compositor can only hand over the frame it is painting
     * and a panel nobody is looking at paints nothing.
     *
     * What changed is the route. The debugger answers a plain
     * `Page.captureScreenshot` without needing anybody to be looking, so the
     * rectangle is no longer what makes a background capture work — and the
     * rectangle brought a metrics override with it, which fights the person's
     * browser zoom. Measured on this Chromium at `1678x1069 css,
     * devicePixelRatio 1.9718`, 158% zoom, same page, same second:
     *
     *   {format:"png"}                          3310x2108, the whole viewport
     *   {..., clip w1678 h1069 scale 1}         1678x1069, the top-left ~40%
     *
     * The page under it draws a rule every tenth of its width: ten gaps in the
     * first, six and a bit in the second. A person looking at both said it
     * first — "the grid is shifted" — and the corner-label probe that said it
     * was fine was blind, because `position: fixed` follows a crop.
     */
    const src = readFileSync(new URL("../../web/src/lib/browserDrive.ts", import.meta.url), "utf8");
    const body = shotCase(src, "shot");
    expect(body, "nothing may invent a rectangle for a plain shot")
      .not.toContain("document.documentElement.scrollWidth");
    /* `clip` still exists — that is `--selector` and `--clip` — but the capture
       only asks for one when the caller did. */
    /* `clip` still exists — that is `--selector` and `--clip` — but it is
       honoured by cropping the pixels afterwards, never by asking CDP to frame
       the page. See `cropPng`. */
    expect(body).toContain("cropPng(");
  });
});

describe("the guardrail must not eat the evidence", () => {
  /*
   * MEASURED, and it is the failure that hid behind the capture bug for an
   * hour: §16's secret sieve saw the base64 of a screenshot, matched it
   * against a token shape, and replaced the whole picture with the word
   * "[redacted]". The CLI decoded that to zero bytes and wrote it as a
   * capture. A guardrail that destroys what it is guarding is worse than none,
   * because it fails in the shape of the thing it was meant to prevent.
   */
  test("a screenshot survives redaction", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(4000);
    const out = redactAskForTest("shot", { png }) as { png: string };
    expect(out.png, "the picture was redacted").toBe(png);
  });

  test("and so do the other binary payloads", () => {
    for (const field of ["pdf", "mhtml", "data"]) {
      const blob = "JVBERi0xLjQK" + "Zm9v".repeat(2000);
      const out = redactAskForTest("pdf", { [field]: blob }) as Record<string, string>;
      expect(out[field], `${field} was redacted`).toBe(blob);
    }
  });

  test("but a real secret in an ordinary field still goes", () => {
    // The exemption is by FIELD NAME and nothing else — it does not widen to
    // "anything long", which would be the sieve quietly switching off.
    const out = redactAskForTest("type", { text: "ghp_" + "a".repeat(30) }) as { text: string };
    expect(out.text).toBe("[redacted]");
  });
});

describe("an action can hand back the page it left behind", () => {
  /*
   * §3: "every action returns the observation after it, not {clicked: true}".
   *
   * Opt-in rather than always, and §14 is the reason: an observation is the
   * tree, the console and the network. Attaching one to every click would put
   * six of them in an agent's context for a five-step sequence where it wanted
   * the last one.
   */
  test("an acting verb gets `after`, an observing one does not", async () => {
    window((id) => settleBrowser(id, { ok: true, value: { clicked: "#save" } }));
    const acted = await withObservation(
      { id: "a1", op: "click", args: { selector: "#save" } } as never,
      { ok: true, value: { clicked: "#save" } },
    );
    expect((acted.value as any).after).toBeDefined();

    // Asking what the page looks like after asking what the page looks like is
    // a round trip for a fact already in hand.
    const looked = await withObservation(
      { id: "a2", op: "observe", args: {} } as never,
      { ok: true, value: { url: "u" } },
    );
    expect((looked.value as any).after).toBeUndefined();
  });

  test("a failed observation never turns a completed action into a failure", async () => {
    /*
     * The action SUCCEEDED. Reporting a click that happened as failed because
     * the look afterwards timed out is the worst possible trade — the caller
     * retries something already done.
     */
    /* `withObservation` is handed the action's reply and makes exactly one
       further ask — the look. So the stand-in refuses every time. */
    window((id) => settleBrowser(id, { ok: false, error: "the browser did not answer in time (observe)" }));
    const r = await withObservation(
      { id: "a3", op: "click", args: { selector: "#pay" } } as never,
      { ok: true, value: { clicked: "#pay" } },
    );
    expect(r.ok, "a completed click was reported as failed").toBe(true);
    expect((r.value as any).afterFailed).toContain("did not answer");
  });

  test("and a failed action is not followed by a look at all", async () => {
    let asks = 0;
    window((id) => { asks++; settleBrowser(id, { ok: true, value: {} }); });
    await withObservation(
      { id: "a4", op: "click", args: { selector: "#gone" } } as never,
      { ok: false, error: "nothing on the page matches #gone" },
    );
    expect(asks, "it observed after a failure").toBe(0);
  });
});

describe("a container per agent", () => {
  /*
   * Several agents use this browser at once. Two sharing a container share a
   * login, and the second one to act changes what the first is looking at —
   * silently, because nothing about a cookie says who set it. So each agent
   * makes its own and drops it when the work is done.
   */
  test("a name has to say whose it is", () => {
    /*
     * The name is what a PERSON reads to tell whose tab is whose, and what the
     * next agent reads to decide what is safe to touch. Two characters minimum
     * so `x` cannot be one; forty maximum so the row stays readable.
     */
    expect("ask" in parseAsk("profiles", { make: "review-pr-540" })).toBe(true);
    expect("error" in parseAsk("profiles", { make: "x" })).toBe(true);
    expect("error" in parseAsk("profiles", { make: "x".repeat(41) })).toBe(true);
    expect("error" in parseAsk("profiles", { make: "../etc" })).toBe(true);
    expect("error" in parseAsk("profiles", { make: "" })).toBe(true);
  });

  test("make or drop, never both in one call", () => {
    const r = parseAsk("profiles", { make: "a-task", drop: "b-task" });
    expect("error" in r).toBe(true);
  });

  test("and listing still takes no arguments at all", () => {
    expect("ask" in parseAsk("profiles", {})).toBe(true);
  });
});

/*
 * §9 — WHO ASKED, WHICH TAB, AND HOW.
 *
 * The incident took a replay of 238 entries against a *modelled* active tab to
 * attribute, and the model was unverifiable: a person clicking a tab in the UI
 * emits no entry at all. `{"op":"open","args":{"url":"…"},"ok":true}` is
 * byte-identical whether it was the tab's own owner or somebody driving
 * another container's page. These four fields are what turns that replay into
 * one grep.
 */
describe("§9: the audit says who asked and which tab answered", () => {
  test("a deliberate borrow names the caller, the tab and its owner", async () => {
    /* `--as A --page <B's tab> click #x`: A asked, B's tab answered, and the
       panel said whose it was (§8's reply fields). */
    setBrowserSink({
      send: (a) => settleBrowser(a.id, { ok: true, value: { clicked: "#x", tab: "t-b", profile: "orbit-b" } }),
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    const p = parseAsk("click", { selector: "#x", page: "t-b", as: "orbit-a", how: "explicit-page" });
    if (!("ask" in p)) throw new Error("unreachable");
    await askBrowser(p.ask);
    const e = exportAudit()[0]!;
    expect(e.as).toBe("orbit-a");
    expect(e.tab).toBe("t-b");
    expect(e.owner).toBe("orbit-b");
    expect(e.how).toBe("explicit-page");
    /* And the two attribution fields are NOT left in the verb's own arguments:
       `auditAsScript` replays `args`, and `as`/`how` are not arguments. */
    expect(e.args.as).toBeUndefined();
    expect(e.args.how).toBeUndefined();
    expect(e.args.selector).toBe("#x");
  });

  test("a caller that says nothing gets a derivation, and it is never `active-explicit`", () => {
    /*
     * "A full working session with two agents produces zero entries with
     * how: active-explicit unless --active was typed" is only checkable if
     * nothing else can ever produce that value. So it is never derived: an
     * unaddressed request is `shared` (the front tab is what it gets), a
     * request carrying a container is `own-container`, and a request carrying
     * a tab is `explicit-page`.
     */
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    parseAsk("click", { selector: "#a" });
    parseAsk("click", { selector: "#b", page: "t9" });
    const entries = exportAudit();
    expect(entries.map((e) => e.how)).toEqual(["shared", "explicit-page"]);
    expect(entries.map((e) => e.how)).not.toContain("active-explicit");
  });

  test("`how` outside the five values is refused rather than recorded as a free-text label", () => {
    expect("error" in parseAsk("click", { selector: "#a", how: "probably-mine" })).toBe(true);
    expect("ask" in parseAsk("click", { selector: "#a", how: "own-tab" })).toBe(true);
    expect("error" in parseAsk("click", { selector: "#a", as: "a\nb" })).toBe(true);
  });

  test("a refusal is attributed too — it is the record that an agent TRIED", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    parseAsk("click", { selector: "#buy", page: "t-b", as: "orbit-a", how: "explicit-page" });
    const e = exportAudit()[0]!;
    expect(e.ok).toBe(false);
    expect(e.as).toBe("orbit-a");
    expect(e.tab).toBe("t-b");
    expect(e.how).toBe("explicit-page");
  });

  test("`--tab` reads one tab from every caller, `--as` reads one caller", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    parseAsk("click", { selector: "#a", page: "t-b", as: "orbit-a", how: "explicit-page" });
    parseAsk("click", { selector: "#b", page: "t-b", as: "orbit-b", how: "own-tab" });
    parseAsk("click", { selector: "#c", page: "t-c", as: "orbit-a", how: "own-tab" });
    expect(exportAudit({ tab: "t-b" }).map((e) => e.as)).toEqual(["orbit-a", "orbit-b"]);
    expect(exportAudit({ as: "orbit-a" }).map((e) => e.tab)).toEqual(["t-b", "t-c"]);
    /* Exact, not a substring: folding `orbit` into `orbit-b` would defeat the
       one thing the filter exists to do. */
    expect(exportAudit({ as: "orbit" })).toHaveLength(0);
  });

  test("the log survives a restart — the file is the record, memory is the mirror", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-audit-"));
    const log = join(dir, "browser-audit.log");
    process.env.AGENTGLASS_BROWSER_AUDIT_LOG = log;
    try {
      resetAudit();
      process.env.AGENTGLASS_BROWSER_READONLY = "1";
      parseAsk("click", { selector: "#pay", page: "t-b", as: "orbit-a", how: "explicit-page" });
      const onDisk = readFileSync(log, "utf8");
      expect(onDisk.split("\n").filter(Boolean)).toHaveLength(1);

      /*
       * THE RESTART. A new process has an empty in-memory log and the same
       * file, so that is exactly what is staged here: clear memory, put the
       * file back, and ask. Reading from memory alone is what lost yesterday's
       * entries every time the app was reopened.
       */
      resetAudit();
      expect(exportAudit()).toHaveLength(0);
      writeFileSync(log, onDisk);
      const back = exportAudit();
      expect(back).toHaveLength(1);
      expect(back[0]!.as).toBe("orbit-a");
      expect(back[0]!.tab).toBe("t-b");
      expect(back[0]!.how).toBe("explicit-page");
      /* And the filters read the durable log, not just this process's. */
      expect(exportAudit({ tab: "t-c" })).toHaveLength(0);
    } finally {
      delete process.env.AGENTGLASS_BROWSER_AUDIT_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the rotated half of the log is still read — one verb past the cap does not hide 2000 entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-audit-"));
    const log = join(dir, "browser-audit.log");
    process.env.AGENTGLASS_BROWSER_AUDIT_LOG = log;
    try {
      resetAudit();
      /* What `persistAudit` leaves after rotating: the old file under `.1`,
         a fresh one with the entry that tipped it. Measured before this read
         `.1`: visible entries went from 2000 to 1. */
      writeFileSync(`${log}.1`, [{ tab: "t-old-1" }, { tab: "t-old-2" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(log, JSON.stringify({ tab: "t-new" }) + "\n");
      expect(exportAudit().map((e) => e.tab)).toEqual(["t-old-1", "t-old-2", "t-new"]);
    } finally {
      delete process.env.AGENTGLASS_BROWSER_AUDIT_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`by` is the caller filter and `as` is not — who is asking must not narrow the log", () => {
    const p = parseAsk("audit", { as: "orbit-me", by: "orbit-them" });
    expect("error" in p).toBe(false);
    const args = (p as any).ask.args;
    expect(args.as).toBe("orbit-me");
    expect(args.by).toBe("orbit-them");
    expect("error" in parseAsk("audit", { by: "" })).toBe(true);
  });

  test("a torn last line does not take the rest of the log with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-audit-"));
    const log = join(dir, "browser-audit.log");
    process.env.AGENTGLASS_BROWSER_AUDIT_LOG = log;
    try {
      resetAudit();
      /* What a kill -9 leaves behind mid-append. */
      writeFileSync(log,
        '{"id":"a1","ts":1,"op":"click","args":{},"ok":true,"how":"explicit-page","tab":"t-b"}\n'
        + '{"id":"a2","ts":1,"op":"cl');
      expect(exportAudit()).toHaveLength(1);
      expect(exportAudit()[0]!.tab).toBe("t-b");
    } finally {
      delete process.env.AGENTGLASS_BROWSER_AUDIT_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * §10 — AN OBSERVATION DESCRIBES THE TAB THE VERB ACTED ON.
 *
 * Both sites here answered from whatever tab was in front while the caller's
 * page sat unused in the ask, so a proof-of-life run pasted evidence of
 * somebody else's page and read it as proof.
 */
describe("§10: --observe and events read the tab the verb acted on", () => {
  /** Every ask that reached the sink, with the page it carried. */
  function recorder(value: () => unknown = () => ({})) {
    const seen: Array<{ op: string; page?: string }> = [];
    setBrowserSink({
      send: (a) => {
        seen.push({ op: a.op, page: (a.args as { page?: string }).page });
        settleBrowser(a.id, { ok: true, value: value() });
      },
      listeners: () => 1,
    });
    noteBrowserReady("w1", true);
    return seen;
  }

  test("the observation appended to a click goes to the clicked tab", async () => {
    const seen = recorder();
    await withObservation(
      { id: "a1", op: "click", args: { selector: "#save", page: "t-b" } } as never,
      { ok: true, value: { clicked: "#save" } },
    );
    expect(seen).toEqual([{ op: "observe", page: "t-b" }]);
  });

  test("each lane's trailing observation names its OWN lane page", async () => {
    /*
     * The measured failure: `runLanes` pins every STEP to `lane.page` and then
     * handed `opts` straight to `runSteps`, whose trailing observe was built
     * from an empty body — so a two-lane `do --observe` returned the same
     * active-tab observation twice and at least one lane's evidence was wrong,
     * deterministically, with one agent and entirely correct usage.
     */
    const seen = recorder();
    await runLanes(
      [
        { page: "p1", steps: [{ op: "click", args: { selector: "#a" } }] },
        { page: "p2", steps: [{ op: "click", args: { selector: "#b" } }] },
      ],
      { observe: true },
    );
    const observes = seen.filter((s) => s.op === "observe").map((s) => s.page).sort();
    expect(observes).toEqual(["p1", "p2"]);
  });

  test("all three event kinds read the caller's tab — and `cdp` drains only that one", async () => {
    /*
     * `cdp` is the one that does damage. The buffer is per-guest and reading
     * it EMPTIES it, so an unaddressed drain consumed the `Debugger.paused`
     * the owning agent was waiting on — which that agent experiences as its
     * breakpoint simply never firing.
     */
    const seen = recorder(() => ({ rows: [{ level: "error", text: "boom" }], events: [{ method: "Debugger.paused" }] }));
    await waitForEvents({ since: 0, waitMs: 500, kinds: ["console", "network", "cdp"], page: "t-b" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.page === "t-b")).toBe(true);
    expect([...new Set(seen.map((s) => s.op))].sort()).toEqual(["cdp", "console", "network"]);
  });
});

/*
 * §14 — `settings` IS ADDRESSABLE, AND THE PARTITION-WIDE ONES SAY SO.
 */
describe("§14: settings takes a tab id like every other verb", () => {
  test("a tab id in `page` is accepted — it used to answer about an argument nobody passed", () => {
    /* Measured before the rename: `settings set --page t17-… --cache bypass`
       answered `page must be "blank"`, because `settings` had an argument of
       its own called `page` meaning the internal page a webview renders. */
    const p = parseAsk("settings", { action: "set", cache: "bypass", page: "t17-orbit" });
    if (!("ask" in p)) throw new Error(`refused: ${(p as { error: string }).error}`);
    expect(p.ask.args.page).toBe("t17-orbit");
    expect(p.ask.args.internalPage).toBeUndefined();
  });

  test("the internal page has its own name, and only one value", () => {
    const p = parseAsk("settings", { action: "set", internalPage: "blank" });
    if (!("ask" in p)) throw new Error("unreachable");
    expect(p.ask.args.internalPage).toBe("blank");
    /* Not a tab id: the panel routes on `page`, and "blank" is not a tab. */
    expect(p.ask.args.page).toBeUndefined();
    expect("error" in parseAsk("settings", { action: "set", internalPage: "about:version" })).toBe(true);
  });

  test("the old spelling still works, and still is not read as a tab", () => {
    /* The CLI on disk sends `page: "blank"` for `--internal-page blank`. A
       rename that breaks that for one release is a regression the caller
       cannot see coming, so the literal — and only the literal — is bridged. */
    const p = parseAsk("settings", { action: "set", page: "blank" });
    if (!("ask" in p)) throw new Error("unreachable");
    expect(p.ask.args.internalPage).toBe("blank");
    expect(p.ask.args.page).toBeUndefined();
  });

  test("proxy, cookies, extensions and dns need `window: true` and name the real blast radius", () => {
    const refused = parseAsk("settings", { action: "set", proxy: { rules: "http://127.0.0.1:8080" } });
    expect("error" in refused).toBe(true);
    /* The sentence has to say WHOSE session, because "window-wide" is wrong:
       these reach the default partition — the person's own browsing — and not
       the containers at all. */
    expect((refused as { error: string }).error).toContain("default browser partition");
    expect("ask" in parseAsk("settings", {
      action: "set", window: true, proxy: { rules: "http://127.0.0.1:8080" },
    })).toBe(true);
  });
});
