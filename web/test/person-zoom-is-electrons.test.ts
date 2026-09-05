/*
 * A PERSON'S ZOOM SCALES THE PAGE; AN AGENT'S EMULATES A SCREEN.
 *
 * Reported with three screenshots — 110%, 140%, 240% — in every one of which
 * the page kept its size and the RECTANGLE it was drawn in shrank, leaving a
 * small page in a large empty area: "it doesn't zoom, it does something weird".
 *
 * That is exactly what `Emulation.setDeviceMetricsOverride` does. It narrows
 * the layout VIEWPORT, and a `<webview>` keeps the box it always had, so the
 * page is laid out for a smaller window and drawn at the same scale. It is the
 * right primitive for `zoom` the verb — an agent asking to see a page as a
 * phone would — and the wrong one for a person leaning in.
 *
 * Electron has the right one and it is reachable only from the main process:
 * `webContents.setZoomFactor`, which scales the page inside the box.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the shell's door", () => {
  test("sets the zoom factor on the guest the caller named", () => {
    const main = read("../../electron/main.js");
    const at = main.indexOf('ipcMain.handle("ag:browserZoom"');
    expect(at).toBeGreaterThan(0);
    const body = main.slice(at, main.indexOf("ipcMain.handle(", at + 30));
    expect(body).toContain("setZoomFactor");
    /* Reading goes through the same door, so a read and a set cannot disagree
       about what the page is at. */
    expect(body).toContain("getZoomFactor");
    /* And an id we do not know is REFUSED, never served from the front tab:
       the silent fallback is what had captures photographing another page. */
    expect(body).toContain("that tab is not a browser pane in this window");
  });

  test("and it is exposed to the renderer", () => {
    expect(read("../../electron/preload.js")).toContain('ipcRenderer.invoke("ag:browserZoom"');
  });
});

describe("what the panel reaches for", () => {
  const panel = read("../src/components/BrowserPanel.tsx");
  /** `applyZoom`, which is the person's path — up to the end of its body. */
  const applyZoom = panel.slice(
    panel.indexOf("const applyZoom = useCallback("),
    panel.indexOf("setPageZoomer(async (dir)"),
  );

  test("the shell's zoom first, for a person", () => {
    expect(applyZoom).toContain("browserZoom(");
    const shell = applyZoom.indexOf("browserZoom(");
    const override = applyZoom.indexOf("applyGuestZoom(");
    expect(shell).toBeGreaterThan(0);
    expect(override).toBeGreaterThan(shell);
  });

  test("the override stays as the fallback, not as the answer", () => {
    /* A build whose shell has no such door still zooms — oddly, but a zoom
       that does something odd beats a dead key, which is what a person with no
       keyboard reach into a `<webview>` would otherwise have. */
    expect(applyZoom).toContain("applyGuestZoom(");
  });

  test("the level shown is what the page ended up at, not what was asked", () => {
    /* Driven by the asked-for level, the chip once read 120% while the page
       was at 96%. Both paths read back. */
    expect(applyZoom).toContain("Math.log(viaShell.factor)");
    expect(applyZoom).toContain("Math.log(r.value.factor)");
  });
});

describe("and the verb says what it actually is", () => {
  /*
   * The verb's own help said "the browser's own zoom — the one Ctrl+ and Ctrl-
   * move", and that sentence was true when there was one mechanism for both.
   * There are two now, and a help string describing the OTHER one is how an
   * agent picks the wrong tool and reports success.
   */
  test("the CLI does not claim to be the person's zoom", () => {
    const cli = read("../../bin/agentglass-browser");
    const at = cli.indexOf('sub.add_parser("zoom"');
    expect(at).toBeGreaterThan(0);
    const help = cli.slice(at, cli.indexOf('sub.add_parser("html"', at));
    expect(help).not.toContain("the one Ctrl+ and Ctrl- move");
    expect(help).toContain("device metrics override");
    expect(help).toContain("layout VIEWPORT");
  });

  test("and neither does the server", () => {
    const drive = read("../../server/src/browserdrive.ts");
    const at = drive.indexOf('case "zoom": {');
    const body = drive.slice(at, drive.indexOf('case "html": {', at));
    expect(body).not.toContain("THE BROWSER'S OWN ZOOM");
    expect(body).toContain("setZoomFactor");
  });
});

describe("save enables the Page domain before it asks for a snapshot", () => {
  test("because captureSnapshot does not fail — it hangs", () => {
    /*
     * Measured on a four-line local page, twice, with the tab in front:
     * `Page.captureSnapshot` sat until the shell's 8-second deadline reset the
     * session. The same call on a tab that had been sent `Page.enable`
     * answered at once and `save` wrote 1404 bytes.
     *
     * Third time this file has met the shape — `captureScreenshot` on a tab
     * that is not compositing, `Fetch.enable` with nobody answering — and it
     * is the one a caller cannot diagnose, because a hang looks like a slow
     * page.
     */
    const src = read("../src/lib/browserDrive.ts");
    const at = src.indexOf('case "save": {');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('case "intercept": {', at));
    const enable = body.indexOf('cdp("Page.enable"');
    const snap = body.indexOf('cdp("Page.captureSnapshot"');
    expect(enable).toBeGreaterThan(0);
    expect(snap, "the enable has to come first, or it is decoration").toBeGreaterThan(enable);
  });
});
