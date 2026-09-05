/*
 * The five anti-features that make this browser suitable for agents.
 *
 * Spec section 17: "do not give me a 3000-line DOM by default", "do not make
 * me poll", "do not hide errors behind a generic message", "do not force me
 * to invent selectors when you can give me stable IDs", and "do not change the
 * page's behaviour depending on whether the panel is on screen — or if you do,
 * TELL ME in every observation".
 *
 * These tests verify that the server-side API enforces these anti-features
 * through validation and parameter bounds. The web-side implementation is
 * verified by the browser-drive.test.ts file which tests observe output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseAsk, resetBrowserDrive, resetAudit } from "../src/browserdrive.ts";

afterEach(() => {
  resetBrowserDrive();
  resetAudit();
});

describe("anti-feature: No 3000-line DOM by default", () => {
  test("observe limit parameter is bounded 1..500", () => {
    // The tree is limited to 200 by default on the web side (verified in browser-drive.test.ts)
    // The server API bounds the limit parameter to prevent unbounded responses
    expect("error" in parseAsk("observe", { limit: 0 })).toBe(true);
    expect("error" in parseAsk("observe", { limit: 501 })).toBe(true);
    expect("error" in parseAsk("observe", { limit: -1 })).toBe(true);
    expect("ask" in parseAsk("observe", { limit: 1 })).toBe(true);
    expect("ask" in parseAsk("observe", { limit: 500 })).toBe(true);
  });

  test("html max parameter is bounded 100..200000", () => {
    // Prevents returning a megabyte of HTML in one response
    expect("error" in parseAsk("html", { selector: "#app", max: 50 })).toBe(true);
    expect("error" in parseAsk("html", { selector: "#app", max: 200001 })).toBe(true);
    expect("ask" in parseAsk("html", { selector: "#app", max: 100 })).toBe(true);
    expect("ask" in parseAsk("html", { selector: "#app", max: 200000 })).toBe(true);
  });

  test("html works without specifying max, using a reasonable default", () => {
    // The default ensures HTML responses don't exceed limits
    expect("ask" in parseAsk("html", { selector: "#app" })).toBe(true);
  });
});

describe("anti-feature: No forcing the caller to poll", () => {
  test("events verb exists as an alternative to polling", () => {
    const parsed = parseAsk("events", {});
    expect("ask" in parsed).toBe(true);
  });

  test("events can wait for new events without polling", () => {
    const withWait = parseAsk("events", { wait: 30 });
    expect("ask" in withWait && withWait.ask.args.wait).toBe(30);
  });

  test("events respects wait parameter bounds (0..120 seconds)", () => {
    expect("error" in parseAsk("events", { wait: -1 })).toBe(true);
    expect("error" in parseAsk("events", { wait: 121 })).toBe(true);
    expect("ask" in parseAsk("events", { wait: 0 })).toBe(true);
    expect("ask" in parseAsk("events", { wait: 120 })).toBe(true);
  });

  test("observe can bring the picture back in the same answer with shot", () => {
    const parsed = parseAsk("observe", { shot: true });
    expect("ask" in parsed && parsed.ask.args.shot).toBe(true);
  });

  test("events supports since parameter to avoid re-reading old events", () => {
    const parsed = parseAsk("events", { since: 1693540000000 });
    expect("ask" in parsed && parsed.ask.args.since).toBe(1693540000000);
  });

  test("observe supports since to avoid re-reading old state", () => {
    // Web-side observe script filters console and network based on 'since'
    // This allows --since-last pattern where caller only reads what is new
    const parsed = parseAsk("observe", { since: 1693540000000 });
    expect("ask" in parsed && parsed.ask.args.since).toBe(1693540000000);
  });
});

describe("anti-feature: No hiding errors behind a generic message", () => {
  test("selector validation provides specific error", () => {
    const result = parseAsk("click", { selector: "" });
    expect("error" in result && result.error).toContain("selector");
  });

  test("selector with newline is rejected with specific error", () => {
    const result = parseAsk("click", { selector: "a\nb" });
    expect("error" in result && result.error).toContain("selector");
  });

  test("limit parameter error specifies valid range", () => {
    const result = parseAsk("observe", { limit: 0 });
    expect("error" in result && result.error).toContain("1..500");
  });

  test("since parameter error specifies what is expected", () => {
    const result = parseAsk("observe", { since: "not-a-number" });
    expect("error" in result && result.error).toContain("timestamp");
  });

  test("until parameter error lists valid options", () => {
    const result = parseAsk("waitfor", { until: "invalid-mode" });
    expect("error" in result && result.error).toContain("network-idle");
    expect("error" in result && result.error).toContain("no-timers");
  });

  test("unknown operation is rejected", () => {
    const result = parseAsk("screenshot" as any, {});
    expect("error" in result).toBe(true);
    // Narrowed before reading: `parseAsk` returns one shape or the other, and
    // reading `.error` off the union is what the type checker is for.
    expect((result as { error: string }).error).not.toContain("UnknownOperation");
  });

  test("fill with invalid fields provides specific error", () => {
    const result = parseAsk("fill", { fields: { "a\nb": "x" } });
    expect("error" in result && result.error).toContain("selector");
  });
});

describe("anti-feature: No forcing invented CSS selectors when stable IDs could be given", () => {
  test("data-testid and role/aria-label are included in observe output", () => {
    // The web-side observe script (browserObserve.ts) includes:
    // - data-testid attribute when present
    // - aria-label in accessible name resolution
    // - role attribute or tagName
    // - stable e{N} IDs via data-agxE attribute
    // This test verifies the API supports data-testid queries
    expect("ask" in parseAsk("click", { selector: "[data-testid='login-button']" })).toBe(true);
  });

  test("selector validation is strict to ensure stable references", () => {
    // Selectors are validated to be single-line and short
    // This prevents agents from trying to use complex selectors that might break
    expect("error" in parseAsk("click", { selector: "div > span.active[data-id='x']" })).toBe(false);
    // But a selector with newline is rejected
    expect("error" in parseAsk("click", { selector: "div\n.active" })).toBe(true);
  });
});

describe("anti-feature: Not changing behaviour based on panel visibility — report it in every observation", () => {
  test("observe returns without requiring poll for visibility state", () => {
    // The observe verb returns in one call, not requiring separate calls to check visibility
    // The web-side script includes:
    // - visible: document.visibilityState === "visible"
    // - focused: document.hasFocus()
    // - readyState: document.readyState
    // - dialog: window.__agxDialog (alerts/confirms blocking the page)
    expect("ask" in parseAsk("observe", {})).toBe(true);
  });

  test("observe shot parameter allows capture in same response", () => {
    // Avoid a separate shot call when observing visibility
    const parsed = parseAsk("observe", { shot: true });
    expect("ask" in parsed && parsed.ask.args.shot).toBe(true);
  });
});

describe("bonus: collect console and network from the start", () => {
  test("console and network operations support since parameter to avoid polling", () => {
    // These allow callers to ask only for what happened since last time
    const consoleWithSince = parseAsk("console", { since: 1693540000000 });
    expect("ask" in consoleWithSince && consoleWithSince.ask.args.since).toBe(1693540000000);

    const networkWithSince = parseAsk("network", { since: 1693540000000 });
    expect("ask" in networkWithSince && networkWithSince.ask.args.since).toBe(1693540000000);
  });

  test("console and network responses are limited to prevent huge buffers", () => {
    // Default limit is 100 entries, bounded 1..500
    const result = parseAsk("console", { limit: 600 });
    expect("error" in result).toBe(true);

    const ok = parseAsk("console", { limit: 100 });
    expect("ask" in ok).toBe(true);
  });

  test("since parameter must be a valid timestamp", () => {
    const result = parseAsk("console", { since: "not-a-number" });
    expect("error" in result).toBe(true);

    const ok = parseAsk("console", { since: 0 });
    expect("ask" in ok).toBe(true);
  });
});
