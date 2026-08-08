import type { BrowserAskFrame } from "../../../shared/types.ts";

/**
 * The window's half of "let an agent drive the browser".
 *
 * The server parks the agent's HTTP request and sends the ask down the socket
 * (see server/src/browserdrive.ts); this runs it against the guest and reports
 * back. Kept out of the panel so the interesting part — what each verb actually
 * does to a page — can be tested against a stand-in element instead of a real
 * Chromium.
 *
 * Everything reaches the page through `executeJavaScript`, which is the only
 * door the webview tag offers, and that is exactly why the verbs are a closed
 * set with no `eval` among them: the code below is written here, and a selector
 * arriving from outside is embedded with JSON.stringify rather than pasted into
 * a template. A selector is data. It has been a source of injection everywhere
 * it was ever treated as anything else.
 */

/** The slice of Electron's `<webview>` this needs. Narrowed rather than `any`,
 *  so a fake in a test has to be honest about what it implements. */
export interface DrivableWebview {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** Real key events, delivered to the page the way a keyboard would. A
   *  KeyboardEvent built in JavaScript is not the same thing: it is untrusted,
   *  so it moves no caret, opens no native select and submits no form. */
  sendInputEvent(event: { type: string; keyCode: string }): void;
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** How much page text is worth sending back. An agent reading a page needs the
 *  page, not a novel: past this the useful signal is long gone and the tokens
 *  are not. */
const MAX_TEXT = 20_000;

/** Wait for the guest to finish a navigation it has just been given. Resolves
 *  either way — "it loaded" and "it failed" are both answers, and the failure
 *  text is more useful to an agent than a timeout would be. */
function settled(el: DrivableWebview, timeoutMs = 40_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
      resolve(err);
    };
    const onStop = () => finish(null);
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; isMainFrame?: boolean; errorCode?: number };
      // A subframe that failed is not the page failing, and -3 is the abort
      // that every interrupted navigation reports.
      if (d.isMainFrame === false || d.errorCode === -3) return;
      finish(d.errorDescription || "the page could not be loaded");
    };
    const timer = setTimeout(() => finish("the page did not finish loading"), timeoutMs);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onFail);
  });
}

/** Run one verb against the guest. Throws nothing: every failure is an answer,
 *  because the caller's job is to report it to an agent, not to crash a panel. */
export async function runBrowserAsk(
  el: DrivableWebview,
  ask: BrowserAskFrame,
  /** How to screenshot a pane nobody is looking at — the shell's capture, which
   *  this module deliberately does not import: reaching for it directly would
   *  drag the whole desktop bridge (and an origin, and a fetch) into the one
   *  file whose job is small enough to test without any of them. */
  captureFromShell: () => Promise<string | null> = async () => null,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const sel = JSON.stringify(String(ask.args.selector ?? ""));
  try {
    switch (ask.op) {
      case "open": {
        const url = String(ask.args.url ?? "");
        const nav = settled(el);
        try {
          await el.loadURL(url);
        } catch (e) {
          // ERR_ABORTED (-3) is what Chromium calls the navigation this one just
          // replaced, and Electron rejects loadURL with it — so interrupting a
          // page that was still loading reported failure for a navigation that
          // then succeeded. Measured: `open example.com` over a half-loaded
          // GitHub answered "(-3) loading https://github.com/..." while the new
          // page loaded fine and every later verb saw it.
          //
          // `settled` is the authority either way: a genuinely bad address still
          // arrives as did-fail-load with its own reason.
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("(-3)") && !msg.includes("ERR_ABORTED")) return { ok: false, error: msg };
        }
        const err = await nav;
        if (err) return { ok: false, error: err };
        return { ok: true, value: { url: el.getURL(), title: el.getTitle() } };
      }

      case "read": {
        const value = await el.executeJavaScript(
          `({ url: location.href, title: document.title,
              text: (document.body ? document.body.innerText : "").slice(0, ${MAX_TEXT}) })`,
        );
        return { ok: true, value };
      }

      case "click": {
        // Reports whether it found anything, because "clicked nothing" and
        // "clicked something" are the same shape of success otherwise, and an
        // agent that cannot tell them apart carries on down a path that never
        // happened.
        const hit = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             if (!e) return false;
             e.scrollIntoView({ block: "center" }); e.click(); return true; })()`,
        );
        if (hit !== true) return { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
        // Then a beat, and where we are now. A click is the commonest way a page
        // moves, and answering the instant the element was hit tells an agent
        // nothing about whether it did — measured: a click that navigated was
        // followed by a `back` that acted on the history from before it, because
        // the navigation had not started yet. Not a wait for a navigation that
        // may never come: 250ms and an honest url.
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, value: { clicked: ask.args.selector, url: el.getURL(), title: el.getTitle() } };
      }

      case "type": {
        const text = JSON.stringify(String(ask.args.text ?? ""));
        const submit = ask.args.submit === true;
        const hit = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             if (!e) return false;
             e.focus();
             // The native setter, then an input event: React and every other
             // framework listens for the event and ignores a value assigned
             // behind its back, so a plain e.value = x types into a field that
             // snaps back on the next render.
             const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
             const set = Object.getOwnPropertyDescriptor(proto, "value");
             if (set && set.set) set.set.call(e, ${text}); else e.value = ${text};
             e.dispatchEvent(new Event("input", { bubbles: true }));
             e.dispatchEvent(new Event("change", { bubbles: true }));
             ${submit ? `if (e.form) e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit();
                          else e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));` : ""}
             return true; })()`,
        );
        if (hit !== true) return { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
        if (submit) await settled(el, 20_000);
        return { ok: true, value: { typed: ask.args.selector, submitted: submit } };
      }

      case "wait": {
        // Polled inside the page rather than from here: one round trip instead
        // of one every 100ms, and it sees the DOM as it changes.
        const found = await el.executeJavaScript(
          `new Promise((resolve) => {
             const deadline = Date.now() + 30000;
             const tick = () => {
               if (document.querySelector(${sel})) return resolve(true);
               if (Date.now() > deadline) return resolve(false);
               setTimeout(tick, 120);
             };
             tick();
           })`,
        );
        return found === true
          ? { ok: true, value: { appeared: ask.args.selector } }
          : { ok: false, error: `${ask.args.selector} never appeared` };
      }

      case "back":
      case "forward": {
        const can = ask.op === "back" ? el.canGoBack() : el.canGoForward();
        // Asked before doing it, because Electron's goBack() at the end of the
        // history is a silent no-op — and an agent that reads the same page
        // twice concludes the page did not change, not that it never moved.
        if (!can) return { ok: false, error: `there is nothing ${ask.op === "back" ? "back" : "forward"} from here` };
        const nav = settled(el);
        if (ask.op === "back") el.goBack(); else el.goForward();
        const err = await nav;
        if (err) return { ok: false, error: err };
        return { ok: true, value: { url: el.getURL(), title: el.getTitle() } };
      }

      case "text": {
        const value = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             return e ? { text: (e.innerText || e.textContent || "").slice(0, ${MAX_TEXT}) } : null; })()`,
        );
        return value
          ? { ok: true, value }
          : { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
      }

      case "scroll": {
        // Answers with where it ended up rather than "done": scrolling to the
        // bottom of a page that was already at the bottom, and scrolling a page
        // that cannot scroll at all, are both invisible from a bare success.
        const move = ask.args.selector !== undefined
          ? `{ const e = document.querySelector(${sel});
               if (!e) return null;
               e.scrollIntoView({ block: "center" }); }`
          : ask.args.to !== undefined
            ? `window.scrollTo({ top: ${ask.args.to === "top" ? "0" : "document.body.scrollHeight"} });`
            : `window.scrollBy({ top: ${Number(ask.args.by)} });`;
        const value = await el.executeJavaScript(
          `(() => { ${move}
             return { y: Math.round(window.scrollY),
                      atBottom: Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 1 }; })()`,
        );
        return value
          ? { ok: true, value }
          : { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
      }

      case "press": {
        const key = String(ask.args.key ?? "");
        // Down then up, because a page that only listens for keyup — a search
        // box that closes on Escape, a list that acts on Enter — sees nothing
        // from half a keystroke.
        el.sendInputEvent({ type: "keyDown", keyCode: key });
        el.sendInputEvent({ type: "keyUp", keyCode: key });
        // Enter and the like commonly navigate. Waiting on a navigation that
        // never comes would cost forty seconds a keystroke, so this gives the
        // page a beat and reports where it is, rather than promising either way.
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, value: { pressed: key, url: el.getURL(), title: el.getTitle() } };
      }

      case "shot": {
        // The shell first: its capture can ask for a frame of a pane the window
        // is not showing, and the element's cannot — it hangs or comes back
        // blank instead, which is precisely the case an agent is in. The element
        // stays as the fallback for a shell too old to have been asked.
        // Both halves raced against the clock, for the same reason: a capture of
        // a pane that is painting nothing does not fail, it waits — and a verb
        // that waits until the server gives up tells an agent the browser is
        // broken rather than that the pane is not showing.
        const fromShell = await Promise.race([
          captureFromShell(),
          new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]);
        const png = fromShell ?? await Promise.race([
          el.capturePage().then((i) => i.toDataURL()),
          new Promise<string>((r) => setTimeout(() => r(""), 5000)),
        ]);
        // An empty capture is a data URL with nothing after the comma, and it
        // used to be returned as a success: the CLI then wrote a zero-byte PNG
        // and said where it had put it. Measured, twice, and it is the worst
        // shape of failure here — an agent reports on a screenshot that does not
        // exist. A pane hidden behind another view produces no frames at all,
        // so say that, in the words the caller can act on.
        const payload = png.slice(png.indexOf(",") + 1);
        if (!payload) {
          return { ok: false, error: "the browser pane is not on screen, so there was no frame to capture" };
        }
        return { ok: true, value: { url: el.getURL(), title: el.getTitle(), png } };
      }

      default:
        return { ok: false, error: `unknown operation` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
