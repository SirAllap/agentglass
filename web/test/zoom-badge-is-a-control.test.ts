/*
 * THE WAY BACK FROM A ZOOM YOU CANNOT UNDO.
 *
 * "I cannot adjust the browser's zoom... it is at 358%" — and 358% is the
 * CEILING, `1.2 ** ZOOM_MAX`. The number was drawn as a `<span>` inside the
 * address button: a reading with nothing to act on.
 *
 * Ctrl+0 is not the answer there. Once the pointer and the focus are inside
 * the `<webview>`, the keys never reach this window at all — the same measured
 * fact that made `cdp Input.*` refuse to pretend. With the keyboard out and no
 * control on screen, a page stuck at the top of the ladder had no way down
 * except a menu nobody knew to open.
 *
 * So the number IS the control.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");

/** The address-bar row, from the container to the end of the zoom control. */
function addressRow(): string {
  const at = src.indexOf('onClick={() => setOmni("edit")}');
  expect(at).toBeGreaterThan(0);
  const from = src.lastIndexOf("<div", at);
  return src.slice(from, src.indexOf("</div>", src.indexOf("zoomPercent(zoom)", from)));
}

describe("the zoom badge", () => {
  test("is a button, so the page can be put back", () => {
    const row = addressRow();
    expect(row).toContain("applyZoom(0)");
    /* On a `button`, not a span with a click handler: it has to be reachable
       by keyboard and announce itself. */
    expect(/<button[^>]*onClick=\{\(\) => applyZoom\(0\)\}/.test(row)).toBe(true);
    expect(row).toContain("aria-label");
  });

  test("is a sibling of the address bar, never inside it", () => {
    /*
     * A button inside a button is not a thing the DOM honours — the inner one
     * is dropped, which is how a control can be written, reviewed, and still
     * not exist on screen. The address button must close before this one
     * opens.
     */
    const row = addressRow();
    const closesAddress = row.indexOf("</button>");
    const opensZoom = row.indexOf("applyZoom(0)");
    expect(closesAddress).toBeGreaterThan(0);
    expect(opensZoom).toBeGreaterThan(closesAddress);
  });

  test("says what clicking it will do", () => {
    /* A bare percentage is a reading. The title is what turns it into an
       offer, and it is the only place that says 100% is reachable. */
    const row = addressRow();
    expect(row).toContain("back to 100%");
  });

  test("meets the house minimum for a control", () => {
    /* 20px tall and wide enough for four digits: "the icons come out
       ridiculously small" is a rule by now. */
    const row = addressRow();
    expect(row).toMatch(/minWidth: 3\d/);
    expect(row).toMatch(/height: 2\d/);
  });
});
