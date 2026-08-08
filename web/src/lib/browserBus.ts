import type { BrowserAskFrame } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { captureBrowser } from "./desktop.ts";
import { runBrowserAsk, type DrivableWebview } from "./browserDrive.ts";

/**
 * Where an agent's browser ask goes when it arrives.
 *
 * A bus rather than a direct call, for one reason: the panel that can answer is
 * mounted or it is not, and the socket does not know which. The panel registers
 * itself while it is up; when nothing has, the ask is still answered — with the
 * truth — so the agent gets a sentence instead of the server's timeout.
 *
 * One handler, not a set. Two browser panels answering the same ask would race
 * to report two different results for one request, and the second would be
 * dropped by the server as an unknown id — a bug that would only ever show up
 * on somebody's second window.
 */
let handler: ((ask: BrowserAskFrame) => void) | null = null;

/**
 * This window's name for itself, for the whole time it is up.
 *
 * Per window and not per machine: two windows are two answers to "can you drive
 * a browser", and a shared id would have one of them cancelling the other's
 * registration on the way out. Not persisted for the same reason — a new window
 * is a new registration, and yesterday's is not evidence of anything.
 */
let id = "";
export function clientId(): string {
  if (!id) id = `w${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return id;
}

/**
 * Run an ask and tell the server, which is holding an agent's HTTP request
 * open until this lands.
 *
 * Lives here rather than beside the page logic so that logic imports nothing:
 * what each verb does to a page is the part worth testing, and a test of it
 * should not need an origin, a token or a fetch — which is exactly what pulling
 * in the API client demanded.
 *
 * A failure to report is swallowed. There is nowhere better for it to go, and
 * the request times out on the other side with a sentence of its own.
 */
export async function serveBrowserAsk(el: DrivableWebview | null, ask: BrowserAskFrame): Promise<void> {
  const reply = el
    ? await runBrowserAsk(el, ask, captureBrowser)
    : { ok: false, error: "the browser view is not open in this window" };
  try { await api.browserResult({ id: ask.id, ...reply }); } catch { /* the ask has already timed out */ }
}

export function setBrowserAskHandler(fn: ((ask: BrowserAskFrame) => void) | null): void {
  handler = fn;
}

/**
 * Hand an ask to the panel, if this window has one.
 *
 * Silence when it does not, and that is the fix rather than an oversight: the
 * ask is broadcast to every open client, and a dashboard in an ordinary browser
 * tab is a client with no `<webview>` in it. Answering "the browser view is not
 * open in this window" from there was answering for everybody — first reply
 * wins — while the desktop app sat there able to do the work.
 *
 * Nothing is lost by staying quiet: the server only sends an ask when some
 * window has registered as able to answer it (POST /browser/ready), and fails
 * fast with a sentence when none has.
 */
export function emitBrowserAsk(ask: BrowserAskFrame): void {
  if (handler) handler(ask);
}
