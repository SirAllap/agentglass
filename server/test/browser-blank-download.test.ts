/*
 * A download started from a `target="_blank"` link never landed.
 *
 * Measured on an isolated instance with a local page holding
 * `<a href="/f.txt" download target="_blank">`: the `download` verb armed a
 * directory on the tab, clicked, and timed out with an empty directory. The
 * click made the page ask for a window, the shell turned that into a new tab,
 * and the file was requested by THAT tab — which nothing had armed. Arming is
 * per tab on purpose (a fallback to the profile let a download from any tab
 * land in an agent's directory), so the rule stays and the link is followed
 * where the arming is: while a tab is armed, a window request from it is
 * fetched as a download by the same tab instead of opening a new one.
 *
 * Source assertions, like the download test beside this one: the real thing
 * needs Electron and a guest that emits `will-download`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const main = readFileSync(join(REPO, "electron", "main.js"), "utf8");
const bare = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The window-open handler, cut at its own closing so nothing after it counts. */
function openHandler(): string {
  const start = bare.indexOf("guest.setWindowOpenHandler(");
  expect(start, "the handler moved").toBeGreaterThan(-1);
  const end = bare.indexOf("\n    });", start);
  return bare.slice(start, end);
}

describe("a download from a target=_blank link", () => {
  test("the arming map is shared with the window-open handler", () => {
    expect(bare).toMatch(/^const guestDownloadDir = new Map\(\)/m);
  });

  test("an armed tab fetches the link itself instead of opening a tab", () => {
    const h = openHandler();
    expect(h).toContain("guestDownloadDir.has(guest)");
    expect(h).toContain("guest.downloadURL(safe)");
    // The download is taken before the tab is opened, or both would happen.
    expect(h.indexOf("guest.downloadURL(safe)")).toBeLessThan(h.indexOf("ag:browser-open-tab"));
  });

  test("the URL is still the vetted one, and a lane can download but never open a window", () => {
    const h = openHandler();
    expect(h.indexOf("safeGuestUrl(url)")).toBeLessThan(h.indexOf("guest.downloadURL"));
    // A lane is where agents run the verb, so the fetch comes first; the
    // window a lane may not map is still refused after it.
    expect(h.indexOf("guest.downloadURL")).toBeLessThan(h.indexOf("opts.lane"));
    expect(h).toContain("if (opts.lane) return");
  });
});
