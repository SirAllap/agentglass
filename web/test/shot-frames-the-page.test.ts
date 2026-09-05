/**
 * A PLAIN SHOT IS WHAT IS ON SCREEN, AT THE RESOLUTION THE SCREEN DRAWS IT.
 *
 * This file used to say the opposite — that a plain shot frames the whole
 * DOCUMENT — and that was written from a real failure: a dashboard captured at
 * the pane's width came back with its right-hand column cut off, and the crop
 * moved with the pane, so "the crops are random" looked like the framing.
 *
 * The remedy manufactured a clip out of `document.scrollWidth/Height` and set a
 * metrics override to match, and BOTH of those fight the person's browser zoom.
 * Measured against this Chromium on a page reporting `1678x1069 css,
 * devicePixelRatio 1.9718`, at 158% zoom, same page, same second:
 *
 *     {format:"png"}                              3310x2108   10.0 gaps across
 *     {..., clip w1678 h1069 scale 1}             1678x1069    6.3 gaps
 *     {..., clip w1678 h1069 scale 1.9718}        1064x 678    crops harder
 *
 * The page draws a rule every tenth of its width, so "gaps across" is the whole
 * test: ten means the frame holds the page, six and a bit means it holds 1/zoom
 * of it. What shipped was the middle row — the top-left corner of the page, at
 * half the resolution, and reported twice by the person looking at both: "the
 * capture is nowhere near what I see… it looks shifted, as if it had more
 * zoom."
 *
 * It hid behind a bad probe for an afternoon. A page with a label in each
 * corner comes back with all four even while it is cropped, because
 * `position: fixed` follows the frame. Only something drawn in PAGE coordinates
 * shows it.
 *
 * So a plain shot now asks for nothing: no clip, no override. `--selector` and
 * `--clip` keep the clip path, which is measured in css pixels at 1x and is
 * self-consistent; `--full-page` is still deleted, over tiling.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");

/** The `case "shot"` body, read by balancing braces rather than by a fixed
 *  slice: a comment added inside it must not silently change what is read. */
/** The same source with block comments removed, for a rule about what the CODE
 *  does rather than about what is written near it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function shotCase(): string {
  const at = SRC.indexOf('case "shot": {');
  expect(at, "the shot verb moved").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error("unbalanced");
}

test("a plain shot manufactures no clip of its own", () => {
  const body = shotCase();
  /* The clip came from the document's scroll size, and it brought a metrics
     override with it. Both fight the browser zoom, and the picture that came
     out was the top-left corner. `clip` still exists for the caller who asks
     for one — that is `--selector` and `--clip` — but nothing invents one. */
  expect(body, "the document's own size must not become a clip")
    .not.toContain("document.documentElement.scrollWidth");
  expect(body).not.toContain("document.documentElement.scrollHeight");
});

test("and asks for no override at all, for ANY shot", () => {
  /*
   * The override was kept for a clip for one more round, and that was still
   * wrong: it re-lays the page out, so every coordinate the rectangle was
   * measured against moves. Measured on the running app — a crop of a 90x42
   * element came back 191x89, the right size and completely blank.
   *
   * A rectangle is honoured by cropping the PIXELS now (`cropPng`), so the page
   * is photographed doing exactly what the person can see it doing, which is
   * the only version of this that can be checked by looking at it.
   */
  const body = shotCase();
  expect(body, "nothing may re-lay the page out to take its picture")
    .not.toContain("setDeviceMetricsOverride");
  expect(body, "the rectangle comes out of the pixels").toContain("cropPng(");
});

test("the picture is at the screen's own resolution, not pinned at 1x", () => {
  /*
   * This said the opposite: the viewport was pinned at `deviceScaleFactor: 1`
   * so that a before and an after taken on two machines would be the same size.
   * The cost was the whole point of the picture — on a desktop scaled to 1.25 at
   * 158% zoom, a pane the screen draws with 3310x2108 came back 1678x1069, and
   * text at half resolution reads as a different page. Reported twice, in the
   * same words: "it looks shifted, as if it had more zoom".
   *
   * Comparability comes from the page instead: the capture is always the whole
   * viewport, and the css size it corresponds to is a property of the page, not
   * of the laptop. `dpr` says by how much the two differ.
   */
  const body = shotCase();
  expect(body, "the page's own ratio, not a constant").toContain("window.devicePixelRatio");
  /* Comments stripped first. Every test in this file reads source, and a rule
     written as "this string is absent" trips over the comment that explains why
     it is absent — which is how a test starts arguing with its own docs. */
  expect(code(body)).not.toContain("deviceScaleFactor: 1");
});

test("there is NO scale option — it tiled the page into copies of itself", () => {
  const body = shotCase();
  expect(body, "a rectangle larger than the viewport is filled by REPEATING the page").not.toContain("shotScale");
  expect(body).toContain("scale: 1");
  const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
  const at = cli.indexOf('g.add_argument("--selector", help="crop to just this element")');
  expect(cli.slice(at, at + 1200), "the flag is gone from the command line too").not.toContain("--scale");
});

test("there is no override left to forget to clear", () => {
  /* The rule this replaces was "always clear it, capture or no capture" —
     leaving one on leaves somebody's browser at a size they did not choose, and
     it survives navigation. The stronger version of that rule is not to set one:
     nothing to clear, nothing to leak on a throw. */
  const body = shotCase();
  expect(body).not.toContain("setDeviceMetricsOverride");
  expect(body).not.toContain("clearDeviceMetricsOverride");
});

test("a runaway layout cannot ask for a capture the size of a building", () => {
  /* The cap moved with the framing: nothing in the renderer asks for a
     rectangle the size of a document any more, so the guard lives where a
     whole-page capture is still assembled — the shell's own full-page route,
     which the manual "shoot the whole page" button uses. */
  const main = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");
  expect(main).toContain("16384");
  expect(main).toContain("Math.min");
});

test("the MCP no longer tells agents to resize the viewport first", () => {
  const mcp = readFileSync(new URL("../../bin/agentglass-browser-mcp", import.meta.url), "utf8");
  const at = mcp.indexOf('"name": "browser_shot"');
  /* To the END of that tool's entry, not a fixed number of characters: the
     schema below the description is part of what this asserts, and a window
     that stops short reads as a missing flag. */
  const next = mcp.indexOf('"name": "browser_', at + 10);
  const desc = mcp.slice(at, next === -1 ? mcp.length : next);
  expect(desc, "that advice is what left every capture cropped").not.toContain("make the VIEWPORT");
  expect(desc).toContain("frames the whole document");
  expect(desc, "scale tiled the page; it must not come back through the MCP").not.toContain('"scale"');
  expect(desc).toContain("no scale");
});

test("the surfaces do not drift — scale is gone from all three", () => {
  const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
  const at = cli.indexOf('g.add_argument("--selector", help="crop to just this element")');
  expect(at).toBeGreaterThan(-1);
  expect(cli.slice(at, at + 1600), "the flag is gone from the command line").not.toContain("--scale");
  /* And the server refuses it BY NAME rather than ignoring it, so a caller
     working from an older doc is told instead of getting a tiled picture. */
  const srv = readFileSync(new URL("../../server/src/browserdrive.ts", import.meta.url), "utf8");
  expect(srv).toContain("scale is gone");
});

/**
 * A capture must never TILE the page.
 *
 * `--scale 2` shipped for about an hour producing four copies of the same
 * dashboard in one PNG, and it was the user who saw it — the dimensions were
 * right, so a check that only measured the file passed it.
 *
 * The cause: the metrics override said deviceScaleFactor 2 while the clip had
 * been measured at 1x, so the rectangle asked for was twice the viewport and
 * `captureBeyondViewport` filled the difference by repeating the page. That is
 * the same defect that got `--full-page` deleted, and it is worse than a crash:
 * an agent holding a duplicated picture cannot tell that it is wrong.
 */
test("the highlight box is positioned in DOCUMENT coordinates", () => {
  /* A shot frames the whole document now, so a `position: fixed` box drawn at
     the element's viewport rect lands wherever the viewport happens to be —
     pointing at nothing on any page that scrolls. That regression arrived with
     the framing fix, in the same hour. */
  const src = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");
  const at = src.indexOf("function highlightScript(");
  const fn = src.slice(at, src.indexOf("/** Undoes `highlightScript`", at));
  expect(fn).toContain("window.scrollY");
  expect(fn).toContain("position:absolute");
  expect(fn, "fixed is the viewport; the capture is the document").not.toContain("position:fixed");
});

test("the caption is never clipped to a narrow element", () => {
  /* Capped at the element's own width with ellipsis, a 55px sidebar captioned
     "the table that proves the change" rendered as nothing readable. A caption
     exists to be read. */
  const src = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");
  const at = src.indexOf("function highlightScript(");
  const fn = src.slice(at, src.indexOf("/** Undoes `highlightScript`", at));
  expect(fn).toContain("width:max-content");
  expect(fn, "the element's width must not decide the caption's").not.toContain("Math.max(r.width, 120)");
  // …and it is nudged back inside if it would hang off the page.
  expect(fn).toContain("scrollWidth");
});
