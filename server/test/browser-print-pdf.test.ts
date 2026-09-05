/*
 * `pdf` asked the protocol for something the protocol does not have.
 *
 * The verb called `Page.printToPDF` over CDP and got back:
 *
 *     {"ok": false, "error": "'Page.printToPDF' wasn't found"}
 *
 * Measured on a clean launch, before anything had touched the debugger, and
 * `Page.enable` first changes nothing: the method is not in the surface
 * Chromium exposes to a <webview>'s debugger session. Electron carries the same
 * capability as a webContents call, so that is what answers now.
 *
 * WHY IT LIVES INSIDE THE CDP HANDLER rather than in a channel of its own,
 * which is the part worth guarding. A second channel would have to repeat the
 * block that decides WHICH guest a request is for and refuses an id it does not
 * recognise — and a second copy of that rule is how "every DevTools call went
 * to the tab in front" comes back. It was measured once already: `read`
 * answered from the agent's own page while `shot`, one command later, returned
 * a picture of a different tab, with the right dimensions and plausible
 * content. One resolution, one refusal, shared.
 *
 * So the assertions are about ORDER and SHAPE, both of which are the contract:
 * the guest is resolved before anything is printed, and the reply keeps CDP's
 * `{ data: <base64> }` so the verb passes it through and the CLI decodes it and
 * writes the file — a contract nothing above this line needed to learn about.
 *
 * Verified end to end against the real app by opening the result rather than
 * weighing it: 4 pages, letter, and pdftotext found the title marker, the end
 * marker and all 89 body lines of the source page.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const main = readFileSync(join(REPO, "electron", "main.js"), "utf8");

/** The handler body, from its own `ipcMain.handle` to the next one. */
const handler = (() => {
  const start = main.indexOf('ipcMain.handle("ag:browserCdp"');
  expect(start, "the CDP handler is still called ag:browserCdp").toBeGreaterThan(-1);
  const next = main.indexOf("ipcMain.handle(", start + 20);
  return main.slice(start, next === -1 ? main.length : next);
})();

describe("printing a page to PDF", () => {
  test("is answered by the shell, not asked of the protocol", () => {
    expect(handler).toContain("Page.printToPDF");
    expect(handler, "Electron's own call is what produces the bytes").toContain("printToPDF({");
  });

  test("the guest is resolved before anything is printed", () => {
    // The whole reason this is not its own channel. If the print branch ever
    // moves above the resolution, an unrecognised id would be served from the
    // front tab — silently, with a plausible-looking PDF of the wrong page.
    const resolves = handler.indexOf("browserGuestById");
    const prints = handler.indexOf("Page.printToPDF");
    expect(resolves).toBeGreaterThan(-1);
    expect(prints).toBeGreaterThan(resolves);
  });

  test("an id the shell does not recognise is still refused", () => {
    // Guards the rule the print branch now depends on, in the same file, so a
    // rewrite of one cannot quietly drop the other.
    expect(handler).toContain("that tab is not a browser pane in this window");
  });

  test("the reply keeps the protocol's shape, so the CLI still writes the file", () => {
    const bare = handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // `{ data: <base64> }` is what CDP would have returned and what the verb
    // reads. The CLI decodes `value.pdf` — see bin/agentglass-browser.
    expect(bare).toContain('toString("base64")');
    expect(bare).toMatch(/result:\s*\{\s*data:/);
  });

  test("a failure to print says so rather than answering with nothing", () => {
    const bare = handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The bug this whole sweep is about is a verb that reports success over an
    // effect that did not happen. An empty PDF must not be one of those.
    expect(bare).toContain("the page could not be printed");
  });
});

describe("the verb on the other side", () => {
  const drive = readFileSync(join(REPO, "web", "src", "lib", "browserDrive.ts"), "utf8");

  test("still asks for Page.printToPDF, so the two halves agree on the name", () => {
    // Deliberately the CDP name even though a webContents call answers it: the
    // verb, the CLI and anything built on them keep speaking one language.
    expect(drive).toContain('cdp("Page.printToPDF"');
  });

  test("and still refuses to claim success without data", () => {
    const bare = drive.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(bare).toContain("the page produced no PDF");
  });
});
