/*
 * A file from the Finder, opened in a tab of the agentglass browser.
 *
 * The same door a web link takes (otherLinks.ts openInBrowser), so the tab
 * lands where "Open web links in" puts links: on the bench when it says so,
 * in the browser view otherwise. The browser refuses file: addresses on
 * purpose; the file is served by the engine's page route instead, with a
 * ticket for that one file in place of the token.
 */
import { api, SERVER } from "./api.ts";
import { HAS_BROWSER } from "./desktop.ts";
import { openInBrowser } from "./otherLinks.ts";
import { canOpenInBrowser, pageUrl } from "./paletteModel.ts";
import { otherLinks } from "./termPrefs.ts";

/** Whether the Finder offers "Open in browser" for this file: a page, a picture or a PDF, in a build with the browser. */
export const offersBrowser = (name: string, locked = false): boolean => HAS_BROWSER && !locked && canOpenInBrowser(name);

/** Whether a page's scripts are a choice to offer (a page has them; a picture or PDF does not). */
export const offersScripts = (name: string): boolean => /\.html?$/i.test(name);

/** Open `abs` in an agentglass browser tab, its scripts off unless `scripts`. False when it could not: the caller says so or falls back. */
export async function openFileInBrowser(abs: string, scripts = false): Promise<boolean> {
  const link = await api.previewPageLink(abs, scripts).catch(() => null);
  if (!link) return false;
  return openInBrowser(pageUrl(SERVER, link.path), otherLinks() === "bench" ? "bench" : "view");
}
