/*
 * `checkup`: enable the protocol's domains, navigate, wait for quiet, and say
 * whether the page broke — errors thrown during load included.
 *
 * The real driver runs against a stand-in guest whose `cdp` records what was
 * enabled and in what order, and whose `cdpEvents` hands back a queue the
 * test fills the way main.js's buffer fills: events stamped with the time
 * they arrived. The page read (CHECKUP_PAGE) runs against a stand-in DOM, the
 * way browser-locators.test.ts runs FIND.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { CHECKUP_PAGE, classifyEvents, type CdpEvent } from "../src/lib/browserCheckup.ts";

const DRIVE = await Bun.file(new URL("../src/lib/browserDrive.ts", import.meta.url)).text();

type Scenario = {
  /** Protocol events the page produces once it is told to load. */
  onLoad?: () => CdpEvent[];
  /** What SETTLE_POLL reads on the n-th poll: [mutations, page inflight]. */
  poll?: (n: number) => [number, number];
  page?: Record<string, unknown>;
  refuse?: string;
  collector?: unknown;
  docAt?: number;
  /** Events already waiting in the buffer when the checkup starts. */
  queued?: CdpEvent[];
  /** The page's own clock — not the panel's once the clock verb moved it. */
  pageNow?: () => number;
  /** The collector was already running when the checkup started. */
  listening?: boolean;
  /** The reload fails to load, in the browser's words. */
  failReload?: string;
};

type Row = { at: number; level?: string; text?: string; method?: string; url?: string; status?: number; error?: string };

const ev = (method: string, params: unknown, at = Date.now()): CdpEvent => ({ at, method, params });

function guest(sc: Scenario = {}) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const log: string[] = [];
  let queue: CdpEvent[] = [...(sc.queued ?? [])];
  let polls = 0;
  let url = "http://localhost:5173/";
  const pageNow = () => (sc.pageNow ?? Date.now)();
  /* The page's window, holding the collector's buffer; the collector read
     is the real script, run against it with the page's clock. */
  const win: { __agxLog?: { console: Row[]; network: Row[]; startedAt: number } } = {};
  if (sc.listening !== false) win.__agxLog = { console: [], network: [], startedAt: pageNow() };
  const emit = (type: string, props: Record<string, unknown> = {}) => {
    for (const fn of listeners.get(type) ?? []) fn(Object.assign(new Event(type), { isMainFrame: true, ...props }));
  };
  const el = {
    loadURL: async (u: string) => {
      log.push("loadURL");
      url = u;
      queue.push(...(sc.onLoad?.() ?? []));
      setTimeout(() => emit("did-stop-loading"), 5);
    },
    reloadIgnoringCache: () => {
      log.push("reloadIgnoringCache");
      queue.push(...(sc.onLoad?.() ?? []));
      setTimeout(() => (sc.failReload
        ? emit("did-fail-load", { errorCode: -105, errorDescription: sc.failReload })
        : emit("did-stop-loading")), 5);
    },
    reload: () => { log.push("reload"); setTimeout(() => emit("did-stop-loading"), 5); },
    goBack: () => {}, goForward: () => {}, canGoBack: () => false, canGoForward: () => false,
    getURL: () => url, getTitle: () => "Orbit",
    capturePage: async () => ({ toDataURL: () => "" }),
    addEventListener: (t: string, fn: (e: Event) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: (e: Event) => void) => { listeners.get(t)?.delete(fn); },
    executeJavaScript: async (code: string) => {
      if (code === CHECKUP_PAGE) return { url, title: "Orbit", docAt: sc.docAt ?? 111, now: pageNow(), ...(sc.page ?? {}) };
      if (code.includes("performance.timeOrigin")) return sc.docAt ?? 111;
      if (code === "!!window.__agxLog") return !!win.__agxLog;
      if (code.includes("window.__agxMut, l = window.__agxLog")) return (sc.poll ?? (() => [0, 0]))(polls++);
      if (code.includes('r.level === "error" && r.at >')) {
        log.push("collector");
        if (sc.collector !== undefined) return sc.collector;
        return new Function("window", "Date", `return ${code}`)(win, { now: pageNow });
      }
      if (code.includes("if (window.__agxLog) return 1")) {
        win.__agxLog ??= { console: [], network: [], startedAt: pageNow() };
      }
      return 1;
    },
  } as unknown as DrivableWebview;
  const cdp = async (method: string) => {
    log.push(`cdp:${method}`);
    return sc.refuse ? { ok: false, error: sc.refuse } : { ok: true, result: {} };
  };
  const cdpEvents = async () => { const out = queue; queue = []; return out; };
  const push = (...e: CdpEvent[]) => queue.push(...e);
  /** Something the page logs now, stamped with the page's clock. */
  const pageSays = (row: Omit<Row, "at">) => {
    const l = win.__agxLog!;
    (row.level ? l.console : l.network).push({ at: pageNow(), ...row });
  };
  return { el, log, cdp, cdpEvents, push, pageSays };
}

type Shell = () => Promise<{ png: string | null; why: string }>;
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const shotOk: Shell = async () => ({ png: PNG, why: "" });

async function checkup(
  g: ReturnType<typeof guest>, args: Record<string, unknown> = {}, shell: Shell = shotOk,
) {
  const r = await runBrowserAsk(
    g.el, { id: "c1", op: "checkup", args } as never,
    shell, async () => {}, async () => ({ ok: false }), g.cdp, g.cdpEvents,
  );
  return r as { ok: boolean; error?: string; value: Record<string, any> };
}

const URL0 = "http://localhost:5173/";

describe("checkup listens before it navigates", () => {
  test("the four domains are enabled, in order, BEFORE the navigation starts", async () => {
    const g = guest();
    const r = await checkup(g, { url: URL0, settleMs: 0 });
    expect(r.ok).toBe(true);
    const nav = g.log.indexOf("loadURL");
    expect(g.log.slice(0, 4)).toEqual(["cdp:Runtime.enable", "cdp:Log.enable", "cdp:Network.enable", "cdp:Audits.enable"]);
    expect(nav).toBe(4);
    // And off again once it has read them: nothing stays enabled.
    expect(g.log.slice(-4)).toEqual(["cdp:Runtime.disable", "cdp:Log.disable", "cdp:Network.disable", "cdp:Audits.disable"]);
  });

  test("a navigation that fails still turns the domains off, and is the answer", async () => {
    const g = guest();
    (g.el as { loadURL: (u: string) => Promise<void> }).loadURL = async () => {
      g.log.push("loadURL");
      throw new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'http://orbit.invalid/'");
    };
    const r = await checkup(g, { url: "http://orbit.invalid/", settleMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(g.log.slice(-4)).toEqual(["cdp:Runtime.disable", "cdp:Log.disable", "cdp:Network.disable", "cdp:Audits.disable"]);
  });

  test("a reload that fails is reported like a navigation that fails", async () => {
    const r = await checkup(guest({ failReload: "net::ERR_CONNECTION_REFUSED" }), { reload: true, settleMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net::ERR_CONNECTION_REFUSED");
  });

  test("a drain as long as the buffer says the oldest events of the load are missing", async () => {
    const flood = () => Array.from({ length: 500 }, (_, i) =>
      ev("Runtime.consoleAPICalled", { type: "log", args: [{ value: `tick ${i}` }] }));
    const r = await checkup(guest({ onLoad: flood }), { url: URL0, settleMs: 0 });
    expect(r.value.note).toContain("the event buffer overflowed: the oldest events of this load are missing");
    const calm = await checkup(guest(), { url: URL0, settleMs: 0 });
    expect(calm.value.note).toBeUndefined();
  });

  test("--reload is a hard reload, after the domains too", async () => {
    const g = guest();
    const r = await checkup(g, { reload: true, settleMs: 0 });
    expect(r.value.since).toBe("load");
    expect(g.log.indexOf("reloadIgnoringCache")).toBeGreaterThan(g.log.indexOf("cdp:Audits.enable"));
  });

  test("the verdict is the first key, and empty keys are left out", async () => {
    const r = await checkup(guest(), { url: URL0, settleMs: 0 });
    expect(Object.keys(r.value)[0]).toBe("verdict");
    expect(r.value.verdict).toBe("ok");
    expect(r.value.errors).toBeUndefined();
    expect(r.value.png).toBeUndefined();
    expect(r.value.dropped).toBeUndefined();
  });
});

describe("what the protocol said is read into errors, failed and issues", () => {
  const t0 = 1_000_000;
  const at = (ms: number) => t0 + ms;
  const req = (id: string, url: string, method = "GET") =>
    ev("Network.requestWillBeSent", { requestId: id, request: { url, method } }, at(1));

  test("an exception thrown at load, with where it was thrown", () => {
    const c = classifyEvents([ev("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught", url: "http://localhost:5173/src/main.ts", lineNumber: 41,
        exception: { description: "TypeError: cannot read properties of undefined (reading 'id')" },
      },
    }, at(2))], t0);
    expect(c.errors).toEqual(["TypeError: cannot read properties of undefined (reading 'id') @ /src/main.ts:42"]);
  });

  test("the first frame is kept, and a location already in it is not said twice", () => {
    const c = classifyEvents([ev("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught", url: "http://localhost:5173/src/main.ts", lineNumber: 3,
        exception: { description: "RangeError: bad\n    at boot (http://localhost:5173/src/main.ts:4:9)\n    at x" },
      },
    }, at(2))], t0);
    expect(c.errors).toEqual(["RangeError: bad at boot (http://localhost:5173/src/main.ts:4:9)"]);
  });

  test("a thrown string is prefixed uncaught; a console.error and an assert are kept", () => {
    const c = classifyEvents([
      ev("Runtime.exceptionThrown", { exceptionDetails: { text: "boom" } }, at(1)),
      ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "save failed" }, { description: "Error: 409" }] }, at(2)),
      ev("Runtime.consoleAPICalled", { type: "assert", args: [{ value: "invariant" }] }, at(3)),
      ev("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }] }, at(4)),
    ], t0);
    expect(c.errors).toEqual(["uncaught boom", "save failed Error: 409", "invariant"]);
  });

  test("Log errors from the network are the failed requests again, and a repeat of Runtime is dropped", () => {
    const c = classifyEvents([
      ev("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: x is not a function" } } }, at(1)),
      ev("Log.entryAdded", { entry: { level: "error", source: "network", text: "Failed to load resource: 500" } }, at(2)),
      ev("Log.entryAdded", { entry: { level: "error", source: "javascript", text: "Uncaught TypeError: x is not a function" } }, at(3)),
      ev("Log.entryAdded", { entry: { level: "error", source: "security", text: "Mixed content blocked" } }, at(4)),
      ev("Log.entryAdded", { entry: { level: "warning", source: "other", text: "slow" } }, at(5)),
    ], t0);
    expect(c.errors).toEqual(["TypeError: x is not a function", "Mixed content blocked"]);
  });

  test("a 500 with its method, a blocked request with its reasons; canceled and data: are not failures", () => {
    const c = classifyEvents([
      req("1", "http://localhost:4000/api/orders", "POST"),
      ev("Network.responseReceived", { requestId: "1", response: { url: "http://localhost:4000/api/orders", status: 500 } }, at(2)),
      req("2", "https://cdn.orbit.example/font.woff2"),
      ev("Network.loadingFailed", {
        requestId: "2", errorText: "net::ERR_FAILED", blockedReason: "corp-not-same-origin",
        corsErrorStatus: { corsError: "MissingAllowOriginHeader" },
      }, at(3)),
      req("3", "http://localhost:4000/api/poll"),
      ev("Network.loadingFailed", { requestId: "3", errorText: "net::ERR_ABORTED", canceled: true }, at(4)),
      req("4", "data:image/png;base64,AAAA"),
      ev("Network.loadingFailed", { requestId: "4", errorText: "net::ERR_INVALID_URL" }, at(5)),
      ev("Network.responseReceived", { requestId: "5", response: { url: "data:text/plain,x", status: 404 } }, at(6)),
      ev("Network.responseReceived", { requestId: "6", response: { url: "http://localhost:4000/ok", status: 200 } }, at(7)),
    ], t0);
    expect(c.failed).toEqual([
      "500 POST http://localhost:4000/api/orders",
      "failed GET https://cdn.orbit.example/font.woff2: net::ERR_FAILED blocked:corp-not-same-origin cors:MissingAllowOriginHeader",
    ]);
  });

  test("repeats fold into one row with a count, newest last", () => {
    const err = (text: string, ms: number) => ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: text }] }, at(ms));
    const c = classifyEvents([err("a", 1), err("b", 2), err("a", 3), err("a", 4)], t0);
    expect(c.errors).toEqual(["b", "a (×3)"]);
  });

  test("events from before the window are not this checkup's", () => {
    const c = classifyEvents([
      ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "old page" }] }, t0 - 5_000),
      ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "new page" }] }, t0 + 1),
    ], t0);
    expect(c.errors).toEqual(["new page"]);
  });

  test("ten rows at most, the newest, and the rest counted in dropped", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: `e${i}` }] }, at(i + 1)));
    const c = classifyEvents(many, t0);
    expect(c.errors).toHaveLength(10);
    expect(c.errors[0]).toBe("e3");
    expect(c.errors[9]).toBe("e12");
    expect(c.dropped).toEqual({ errors: 3 });
  });

  test("a failed request's query string never reaches the answer — it can carry a code or a token", () => {
    const c = classifyEvents([
      req("1", "http://localhost:4000/auth/callback?code=abc123&state=xyz", "GET"),
      ev("Network.responseReceived", { requestId: "1", response: { url: "http://localhost:4000/auth/callback?code=abc123&state=xyz", status: 401 } }, at(2)),
      req("2", "http://localhost:4000/api/me#frag"),
      ev("Network.loadingFailed", { requestId: "2", errorText: "net::ERR_FAILED" }, at(3)),
    ], t0);
    expect(c.failed).toEqual([
      "401 GET http://localhost:4000/auth/callback?...",
      "failed GET http://localhost:4000/api/me: net::ERR_FAILED",
    ]);
    expect(c.failed.join(" ")).not.toContain("abc123");
  });

  test("issues are grouped by code, with a url when one is easy", () => {
    const issue = (code: string, details: unknown, ms: number) => ev("Audits.issueAdded", { issue: { code, details } }, at(ms));
    const c = classifyEvents([
      issue("MixedContentIssue", { mixedContentIssueDetails: { insecureURL: "http://cdn.orbit.example/a.js" } }, 1),
      issue("MixedContentIssue", { mixedContentIssueDetails: { insecureURL: "http://cdn.orbit.example/b.js" } }, 2),
      issue("CookieIssue", { cookieIssueDetails: { cookieWarningReasons: ["WarnSameSiteLaxCrossDowngradeLax"] } }, 3),
    ], t0);
    expect(c.issues).toEqual([
      { code: "MixedContentIssue", n: 2, about: "http://cdn.orbit.example/a.js" },
      { code: "CookieIssue", n: 1 },
    ]);
  });
});

describe("through the driver", () => {
  const brokenLoad = () => [
    ev("Network.requestWillBeSent", { requestId: "9", request: { url: "http://localhost:4000/api/me", method: "GET" } }),
    ev("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: user is undefined" } } }),
    ev("Network.responseReceived", { requestId: "9", response: { url: "http://localhost:4000/api/me", status: 500 } }),
    ev("Network.loadingFinished", { requestId: "9" }),
    ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "old" }] }, Date.now() - 10_000),
  ];

  test("a load that throws and gets a 500 is 2 problems, with the picture", async () => {
    const r = await checkup(guest({ onLoad: brokenLoad }), { url: URL0, settleMs: 1_000 });
    expect(r.value.verdict).toBe("2 problems");
    expect(r.value.errors).toEqual(["TypeError: user is undefined"]);
    expect(r.value.failed).toEqual(["500 GET http://localhost:4000/api/me"]);
    expect(r.value.png).toBe(PNG);
    expect(r.value.since).toBe("load");
  });

  test("one visible error is 1 problem; issues, perf and a11y are advice and count for nothing", async () => {
    const g = guest({
      page: { visible: ["Payment failed"], perf: { lcpMs: 900 }, a11y: { unlabelled: 2, samples: ["e4 button"] } },
      onLoad: () => [ev("Audits.issueAdded", { issue: { code: "HeavyAdIssue", details: {} } })],
    });
    const r = await checkup(g, { url: URL0, settleMs: 0, noShot: true });
    expect(r.value.verdict).toBe("1 problem");
    expect(r.value.issues).toEqual([{ code: "HeavyAdIssue", n: 1 }]);
    const clean = await checkup(guest({ page: { perf: { lcpMs: 900 }, a11y: { imgNoAlt: 1, samples: ["e2 img"] } } }), { url: URL0, settleMs: 0 });
    expect(clean.value.verdict).toBe("ok");
    expect(clean.value.a11y).toEqual({ imgNoAlt: 1, samples: ["e2 img"] });
  });

  test("three problems are three", async () => {
    const g = guest({
      page: { visible: ["Something went wrong"] },
      onLoad: () => [
        ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "a" }] }),
        ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "b" }] }),
        ev("Runtime.consoleAPICalled", { type: "error", args: [{ value: "a" }] }),
      ],
    });
    const r = await checkup(g, { url: URL0, settleMs: 0, noShot: true });
    expect(r.value.verdict).toBe("3 problems");
  });

  test("settle: stops once nothing is in flight and the page has been quiet 300 ms", async () => {
    const t = Date.now();
    const r = await checkup(guest(), { url: URL0 });
    expect(r.value.loaded.settledBy).toBe("quiet");
    expect(r.value.loaded.settleMs).toBeGreaterThanOrEqual(300);
    expect(Date.now() - t).toBeLessThan(1_500);
  });

  test("settle: a request that never finishes runs into the cap, and says so", async () => {
    const g = guest({
      onLoad: () => [ev("Network.requestWillBeSent", { requestId: "sse", request: { url: "http://localhost:4000/stream", method: "GET" } })],
    });
    const r = await checkup(g, { url: URL0, settleMs: 600 });
    expect(r.value.loaded.settledBy).toBe("cap");
    expect(r.value.loaded.settleMs).toBeGreaterThanOrEqual(600);
    expect(r.value.loaded.settleMs).toBeLessThan(1_200);
  });

  test("settle: a response whose body nobody reads counts as answered", async () => {
    /* Measured in the real guest: a fetch that got a 500 and never read the
       body sent requestWillBeSent and responseReceived, and no
       loadingFinished. Waiting for it ran every broken load into the cap. */
    const g = guest({
      onLoad: () => [
        ev("Network.requestWillBeSent", { requestId: "w", request: { url: "http://localhost:4000/api/widgets", method: "GET" } }),
        ev("Network.responseReceived", { requestId: "w", type: "Fetch", response: { url: "http://localhost:4000/api/widgets", status: 500 } }),
      ],
    });
    const r = await checkup(g, { url: URL0, settleMs: 2_000, noShot: true });
    expect(r.value.loaded.settledBy).toBe("quiet");
  });

  test("settle: a page that keeps changing is not quiet either", async () => {
    const r = await checkup(guest({ poll: (n) => [n, 0] }), { url: URL0, settleMs: 500 });
    expect(r.value.loaded.settledBy).toBe("cap");
  });

  test("no picture when nothing is wrong, none when --no-shot says so", async () => {
    let asked = 0;
    const shell: Shell = async () => { asked++; return { png: PNG, why: "" }; };
    await checkup(guest(), { url: URL0, settleMs: 0 }, shell);
    expect(asked).toBe(0);
    const r = await checkup(guest({ page: { visible: ["Error"] } }), { url: URL0, settleMs: 0, noShot: true }, shell);
    expect(asked).toBe(0);
    expect(r.value.png).toBeUndefined();
    expect(r.value.shot).toBeUndefined();
  });

  test("a capture that never answers is 'unavailable', and the checkup still answers", async () => {
    const t = Date.now();
    const never: Shell = () => new Promise(() => {});
    const r = await checkup(guest({ page: { visible: ["Error"] } }), { url: URL0, settleMs: 0 }, never);
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe("1 problem");
    expect(r.value.shot).toMatch(/^unavailable: /);
    // Bounded by shot's own budget for the shell (12 s), not a new number.
    expect(Date.now() - t).toBeLessThan(14_000);
  }, 20_000);

  test("the failure picture waits exactly as long as shot lets the shell take — one number, shared", () => {
    const code = DRIVE.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const fn = code.slice(code.indexOf("async function checkupWith("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("within(deps.captureFromShell(), SHELL_SHOT_MS)");
    const shot = code.slice(code.indexOf('case "shot": {'));
    expect(shot.slice(0, shot.indexOf('case "inspect": {'))).toContain("SHELL_SHOT_MS)");
    expect(code).toMatch(/\nconst SHELL_SHOT_MS = 12_000;/);
  });

  test("a capture that fails says why", async () => {
    const r = await checkup(guest({ page: { visible: ["Error"] } }), { url: URL0, settleMs: 0 },
      async () => ({ png: null, why: "the browser pane is not on screen" }));
    expect(r.value.shot).toBe("unavailable: the browser pane is not on screen");
  });

  test("the protocol refused (an inspector holds it): the collector answers, with a note saying what is missing", async () => {
    const g = guest({
      refuse: "the inspector is attached to this page — close it and try again",
      collector: { console: ["TypeError: late"], network: [{ method: "GET", url: "http://localhost:4000/x", status: 404 }] },
    });
    const r = await checkup(g, { url: URL0, settleMs: 0, noShot: true });
    expect(r.ok).toBe(true);
    expect(g.log).toContain("collector");
    expect(r.value.errors).toEqual(["TypeError: late"]);
    expect(r.value.failed).toEqual(["404 GET http://localhost:4000/x"]);
    expect(r.value.note).toContain("during load are not visible while the inspector is attached");
  });

  test("Audits refused alone keeps the protocol, and says issues are unavailable", async () => {
    const g = guest();
    g.cdp = (async (m: string) => (m === "Audits.enable" ? { ok: false, error: "not here" } : { ok: true })) as never;
    const r = await checkup(g, { url: URL0, settleMs: 0 });
    expect(r.value.note).toContain("issues unavailable");
    expect(g.log).not.toContain("collector");
  });
});

describe("with no navigation, the collector answers and the protocol is never touched", () => {
  test("no domain is enabled, nothing is drained", async () => {
    const g = guest();
    let drained = 0;
    g.cdpEvents = async () => { drained++; return []; };
    await checkup(g, { settleMs: 0, noShot: true });
    expect(g.log.filter((l) => l.startsWith("cdp:"))).toEqual([]);
    expect(drained).toBe(0);
  });

  test("the first checkup of a document reads everything since the collector started", async () => {
    const g = guest();
    g.pageSays({ level: "error", text: "TypeError: late" });
    g.pageSays({ method: "GET", url: "http://localhost:4000/x?token=s3cret", status: 404 });
    const r = await checkup(g, { settleMs: 0, noShot: true });
    expect(r.value.since).toBe("page load");
    expect(r.value.errors).toEqual(["TypeError: late"]);
    expect(r.value.failed).toEqual(["404 GET http://localhost:4000/x?..."]);
    expect(r.value.note).toBeUndefined();
  });

  test("a second checkup reports only what happened after the first", async () => {
    const g = guest();
    g.pageSays({ level: "error", text: "before" });
    expect((await checkup(g, { settleMs: 0, noShot: true })).value.errors).toEqual(["before"]);
    await Bun.sleep(2);
    g.pageSays({ level: "error", text: "after the click" });
    const second = await checkup(g, { settleMs: 0, noShot: true });
    expect(second.value.since).toBe("last checkup");
    expect(second.value.errors).toEqual(["after the click"]);
    expect((await checkup(g, { settleMs: 0, noShot: true })).value.verdict).toBe("ok");
  });

  test("the window is kept in the PAGE's clock: an advanced clock does not replay old errors", async () => {
    // The clock verb moved the page an hour ahead; every row is stamped in that time.
    const g = guest({ pageNow: () => Date.now() + 3_600_000 });
    g.pageSays({ level: "error", text: "once" });
    expect((await checkup(g, { settleMs: 0, noShot: true })).value.errors).toEqual(["once"]);
    const again = await checkup(g, { settleMs: 0, noShot: true });
    expect(again.value.verdict).toBe("ok");
  });

  test("another document is read whole again", async () => {
    const sc: Scenario = { docAt: 111 };
    const g = guest(sc);
    g.pageSays({ level: "error", text: "old page" });
    await checkup(g, { settleMs: 0, noShot: true });
    sc.docAt = 222;
    const r = await checkup(g, { settleMs: 0, noShot: true });
    expect(r.value.since).toBe("page load");
    expect(r.value.errors).toEqual(["old page"]);
  });

  test("nothing listening before this call: the verdict stands, and the note says how to see the load", async () => {
    const r = await checkup(guest({ listening: false, page: { visible: ["Payment failed"] } }), { settleMs: 0, noShot: true });
    expect(r.value.verdict).toBe("1 problem");
    expect(r.value.since).toBe("this call");
    expect(r.value.note).toBe("nothing was listening before this call: use checkup --reload to see errors from load");
  });
});

/* ── the page read, against a stand-in DOM ──────────────────────────────── */

class N {
  tagName: string;
  attrs: Record<string, string>;
  children: N[] = [];
  parentElement: N | null = null;
  text = "";
  hidden = false;
  value = "";
  type = "";
  labels: N[] = [];
  dataset: Record<string, string>;
  constructor(tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    if (tag === "input") this.type = attrs.type ?? "text";
    if (attrs.value !== undefined) this.value = attrs.value;
    for (const k of kids) {
      if (typeof k === "string") this.text += k;
      else { k.parentElement = this; this.children.push(k); }
    }
    const key = (k: string) => "data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => this.attrs[key(k)],
      set: (_t, k: string, v: string) => { this.attrs[key(k)] = v; return true; },
    });
  }
  shown(): boolean { return !this.hidden && (!this.parentElement || this.parentElement.shown()); }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  get innerText(): string { return this.shown() ? this.text + this.children.map((c) => c.innerText).join("") : this.textContent; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  hasAttribute(k: string) { return k in this.attrs; }
  contains(o: N | null): boolean {
    for (let n = o; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  getBoundingClientRect() { const s = this.shown(); return { x: 0, y: 0, width: s ? 50 : 0, height: s ? 20 : 0 }; }
  all(): N[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

/** `tag`, `[attr]`, `[attr="v"]` and `tag[attr]`, in comma lists. */
function matches(n: N, sel: string): boolean {
  return sel.split(",").some((one) => {
    const m = /^([a-z]*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(one.trim());
    if (!m) throw new SyntaxError(one);
    const [, tag, k, v] = m;
    if (tag && n.tagName !== tag.toUpperCase()) return false;
    if (k && !(k in n.attrs)) return false;
    if (k && v !== undefined && n.attrs[k] !== v) return false;
    return true;
  });
}

const h = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) => new N(tag, attrs, ...kids);

type Entry = { startTime?: number; value?: number; hadRecentInput?: boolean };

function runPage(body: N, entries: Record<string, Entry[]> = {}) {
  const doc = { title: "Orbit — checkout", querySelectorAll: (s: string) => body.all().filter((n) => matches(n, s)) };
  class PO {
    static supportedEntryTypes = ["largest-contentful-paint", "layout-shift", "navigation"];
    constructor(private cb: (l: { getEntries: () => Entry[] }) => void) {}
    /* Delivered later, as Chromium does: never inside observe() itself. */
    observe(o: { type: string }) {
      const got = entries[o.type] ?? [];
      if (got.length) setTimeout(() => this.cb({ getEntries: () => got }), 0);
    }
    takeRecords() { return []; }
    disconnect() {}
  }
  const globals: Record<string, unknown> = {
    document: doc, window: {}, location: { href: "http://localhost:5173/checkout" },
    performance: { timeOrigin: 1234.4, getEntriesByType: () => [{ loadEventEnd: 812.6 }] },
    PerformanceObserver: PO,
    getComputedStyle: (n: N) => ({ display: n.shown() ? "block" : "none", visibility: "visible" }),
    setTimeout,
  };
  return new Function(...Object.keys(globals), `return ${CHECKUP_PAGE}`)(...Object.values(globals)) as Promise<Record<string, any>>;
}

describe("CHECKUP_PAGE, the page half", () => {
  test("unlabelled uses observe's name: a labelled input is fine, an icon-only button is not", async () => {
    const email = h("input", { id: "email", type: "email" });
    email.labels = [h("label", {}, "Email")];
    const body = h("body", {},
      email,
      h("input", { type: "text", placeholder: "Search" }),
      h("input", { type: "hidden", name: "csrf" }),
      h("input", { type: "submit", value: "Pay" }),
      h("button", { class: "icon" }, h("svg")),
      h("button", {}, "Save"),
      h("a", { href: "/x", "aria-label": "Home" }),
      h("div", { role: "button" }),
      h("button", { class: "icon" }),
    );
    body.children[8]!.hidden = true; // a hidden button is nobody's problem
    const out = await runPage(body);
    expect(out.a11y.unlabelled).toBe(2);
    expect(out.a11y.samples).toEqual(["e1 button", "e2 div"]);
    expect(body.children[4]!.attrs["data-agx-e"]).toBe("e1");
  });

  test("an image without alt is counted; alt=\"\" is a decision, not an omission", async () => {
    const out = await runPage(h("body", {}, h("img", { src: "/a.png" }), h("img", { src: "/b.png", alt: "" })));
    expect(out.a11y).toEqual({ imgNoAlt: 1, samples: ["e1 img"] });
  });

  test("a page with nothing to say leaves a11y and visible out", async () => {
    const out = await runPage(h("body", {}, h("button", {}, "Save")));
    expect(out.a11y).toBeUndefined();
    expect(out.visible).toBeUndefined();
    expect(out.url).toBe("http://localhost:5173/checkout");
    expect(out.title).toBe("Orbit — checkout");
  });

  test("visible alerts: collapsed, deduped, three at most; a hidden one is not reported", async () => {
    const hiddenAlert = h("div", { role: "alert" }, "Stale error");
    hiddenAlert.hidden = true;
    const body = h("body", {},
      hiddenAlert,
      h("div", { role: "alert" }, "Payment   failed\n  try again"),
      h("p", { "aria-live": "assertive" }, "Payment failed try again"),
      h("div", { role: "alert" }, "   "),
      h("div", { role: "alert" }, "Card declined"),
      h("div", { "aria-live": "assertive" }, "Session expired"),
      h("div", { role: "alert" }, "A fourth"),
    );
    const out = await runPage(body);
    expect(out.visible).toEqual(["Payment failed try again", "Card declined", "Session expired"]);
  });

  test("an alert inside a live region is one message, not two", async () => {
    const body = h("body", {},
      h("div", { "aria-live": "assertive" }, "Payment: ", h("div", { role: "alert" }, "card declined")),
      h("div", { role: "alert" }, "Session expired"),
    );
    const out = await runPage(body);
    expect(out.visible).toEqual(["Payment: card declined", "Session expired"]);
  });

  test("perf: LCP from the last buffered entry, CLS without shifts that followed input, load time", async () => {
    const out = await runPage(h("body"), {
      "largest-contentful-paint": [{ startTime: 400.2 }, { startTime: 1210.7 }],
      "layout-shift": [{ value: 0.05 }, { value: 0.2, hadRecentInput: true }, { value: 0.0123 }],
    });
    expect(out.perf).toEqual({ lcpMs: 1211, cls: 0.062, loadMs: 813 });
    expect(out.docAt).toBe(1234);
  });

  test("a tab that never painted has no LCP, and says nothing about it", async () => {
    const out = await runPage(h("body"));
    expect(out.perf.lcpMs).toBeUndefined();
    expect(out.perf.cls).toBe(0);
  });
});
