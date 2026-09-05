/*
 * Verify that the observe script implementation respects the five anti-features.
 *
 * These tests directly examine the generated observe script to ensure:
 * 1. No 3000-line DOM by default (tree limited to 200, console/network to 80)
 * 2. No forcing poll (observe returns everything once)
 * 3. No generic errors (specific error checking in validation)
 * 4. Stable IDs given (data-agxE stamping)
 * 5. Visibility always reported (visible, focused in every observation)
 */
import { describe, expect, test } from "bun:test";
import { observeScript, COLLECTOR } from "../src/lib/browserObserve.ts";

describe("observe script anti-features", () => {
  describe("anti-feature 1: No 3000-line DOM by default", () => {
    test("tree is limited to treeMax parameter (default 200)", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("if (tree.length >= 200) break");
    });

    test("respects smaller treeMax limits", () => {
      const script = observeScript(0, 50);
      expect(script).toContain("if (tree.length >= 50) break");
    });

    test("console entries capped at 80 items", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("console: seen(log.console).slice(-80)");
    });

    test("network entries capped at 80 items", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("network: seen(log.network).slice(-80)");
    });

    test("does not include full HTML of elements in tree", () => {
      const script = observeScript(0, 200);
      // Tree contains e (id), role, name, testid, id, disabled, hidden, covered, at (bounds)
      // But not innerHTML or full element content
      expect(script).toContain('e: stamp(el)');
      expect(script).toContain('role: el.getAttribute("role")');
      expect(script).toContain('at: [');
      // Should NOT include innerHTML or huge content
      expect(script).not.toContain("innerHTML");
    });
  });

  describe("anti-feature 2: No forcing the caller to poll", () => {
    test("observe returns all state in one call", () => {
      const script = observeScript(0, 200);
      // The return statement includes all needed fields at once
      expect(script).toContain("return {");
      expect(script).toContain("url:");
      expect(script).toContain("title:");
      expect(script).toContain("visible:");
      expect(script).toContain("focused:");
      expect(script).toContain("console:");
      expect(script).toContain("network:");
      expect(script).toContain("tree");
      expect(script).toContain("form");
    });

    test("supports since parameter to read only new entries", () => {
      const script0 = observeScript(0, 200);
      const script1000 = observeScript(1693540000000, 200);
      // Both should have the filtering logic
      expect(script0).toContain("const seen = (arr) => arr.filter((r) => !0 || r.at >");
      expect(script1000).toContain("const seen = (arr) => arr.filter((r) => !1693540000000 || r.at >");
    });

    test("filters console by since timestamp", () => {
      const script = observeScript(1693540000000, 200);
      expect(script).toContain("console: seen(log.console)");
      // The seen function filters by timestamp
      expect(script).toContain("r.at > 1693540000000");
    });

    test("filters network by since timestamp", () => {
      const script = observeScript(1693540000000, 200);
      expect(script).toContain("network: seen(log.network)");
    });
  });

  describe("anti-feature 3: No hiding errors behind a generic message", () => {
    test("COLLECTOR captures full error messages", () => {
      expect(COLLECTOR).toContain("e.message");
      expect(COLLECTOR).toContain("stack:");
    });

    test("console.error preserves the full error text", () => {
      expect(COLLECTOR).toContain('"error"');
      expect(COLLECTOR).toContain("text:");
    });

    test("uncaught errors are not silently dropped", () => {
      expect(COLLECTOR).toContain("window.addEventListener");
      expect(COLLECTOR).toContain('"error"');
      expect(COLLECTOR).toContain("e.message");
    });

    test("unhandled rejections are captured with their message", () => {
      expect(COLLECTOR).toContain("unhandledrejection");
      expect(COLLECTOR).toContain("e.reason");
    });

    test("dialog state is always reported (it blocks everything)", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("dialog: window.__agxDialog");
    });
  });

  describe("anti-feature 4: No forcing invented CSS selectors when stable IDs could be given", () => {
    test("observe stamps each element with stable e{N} ID", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('el.dataset.agxE = "e"');
      expect(script).toContain("window.__agxSeq");
    });

    test("stable ID is preserved across observations", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("if (!el.dataset.agxE)");
      // Only stamp if not already stamped
      expect(script).toContain("el.dataset.agxE");
    });

    test("tree includes stable ID as first field", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('e: stamp(el)');
    });

    test("covering element is identified by its ID", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("top.dataset.agxE");
      expect(script).toContain('top.dataset.agxE + " "');
    });

    test("data-testid is included in tree", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('testid: el.getAttribute("data-testid")');
    });

    test("aria-label is used in accessible name", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('el.getAttribute("aria-label")');
    });

    test("tree includes role attribute", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('role: el.getAttribute("role")');
    });

    test("tree includes actual element id if present", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("id: el.id");
    });

    test("only interactive elements are included to avoid wall of text", () => {
      const script = observeScript(0, 200);
      // PICK list includes only interactive elements
      expect(script).toContain('const PICK = "a,button,input,select,textarea,[role],[data-testid],summary,h1,h2,h3"');
      expect(script).toContain("document.querySelectorAll(PICK)");
    });
  });

  describe("anti-feature 5: Not changing behaviour based on visibility — report it in every observation", () => {
    test("observe always reports visible state", () => {
      const script = observeScript(0, 200);
      expect(script).toContain('visible: document.visibilityState === "visible"');
    });

    test("observe always reports focused state", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("focused: document.hasFocus()");
    });

    test("visibility and focus are top-level fields in return object", () => {
      const script = observeScript(0, 200);
      // Both are at the same level as url, title, etc
      const returnStart = script.indexOf("return {");
      const visibleIndex = script.indexOf("visible:", returnStart);
      const focusedIndex = script.indexOf("focused:", returnStart);
      expect(visibleIndex).toBeGreaterThan(returnStart);
      expect(focusedIndex).toBeGreaterThan(returnStart);
    });

    test("readyState is reported to show load progress", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("readyState: document.readyState");
    });

    test("viewport dimensions are included for context", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("viewport:");
      expect(script).toContain("window.innerWidth");
      expect(script).toContain("window.innerHeight");
    });

    test("comment explains that visibility affects page behaviour", () => {
      const script = observeScript(0, 200);
      expect(script).toContain("visibilityState");
      expect(script).toContain("background tab");
    });
  });

  describe("COLLECTOR implementation", () => {
    test("COLLECTOR is defined and ready to inject", () => {
      expect(COLLECTOR).toBeDefined();
      expect(typeof COLLECTOR).toBe("string");
      expect(COLLECTOR.length).toBeGreaterThan(100);
    });

    test("COLLECTOR creates window.__agxLog on first injection", () => {
      expect(COLLECTOR).toContain("window.__agxLog");
      expect(COLLECTOR).toContain("if (window.__agxLog) return 1");
    });

    test("COLLECTOR is idempotent (safe to call multiple times)", () => {
      expect(COLLECTOR).toContain("if (window.__agxLog) return");
    });

    test("console methods are wrapped to capture logs", () => {
      const levels = ["log", "info", "warn", "error", "debug"];
      for (const level of levels) {
        expect(COLLECTOR).toContain(`"${level}"`);
      }
    });

    test("errors are truncated to prevent huge buffer", () => {
      expect(COLLECTOR).toContain("slice(0, 2000)");
    });

    test("redaction is built in to prevent secrets in logs", () => {
      expect(COLLECTOR).toContain("[redacted]");
      expect(COLLECTOR).toContain("pass");
      expect(COLLECTOR).toContain("token");
    });
  });
});
