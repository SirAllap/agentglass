/*
 * What each browser verb actually does to a page.
 *
 * Run against a stand-in for the guest, because the interesting failures are
 * about the JavaScript this builds, not about Chromium: a selector pasted into
 * a template instead of being encoded, a click that reports success having hit
 * nothing, and a typed value that a framework throws away on its next render.
 */
import { describe, expect, test } from "bun:test";
import { claimAgentZoom, forgetAgentZoom, reapplyZoom, resetBrowserSettings, runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";

/** Records the code it is asked to run and answers with whatever was queued. */
/*
 * The default answer speaks the shape `resolveOne` returns — `{ kind: "ok" }`
 * — not the bare `true` the page used to hand back. A verb that resolves a
 * selector now distinguishes "matched one", "matched none", "matched several"
 * and "that is not a selector", and a stand-in that answers `true` to all four
 * would let a verb pass while reporting the wrong one.
 */
function fakeGuest(answer: (code: string) => unknown = () => ({ kind: "ok" })) {
  const ran: string[] = [];
  const keys: string[] = [];
  /* `sendInputEvent` is NOT part of `DrivableWebview` any more — it was taken
     out when it was measured that a key sent this way never reaches the guest.
     The fake still carries it, typed here rather than there, precisely so the
     assertion below has something to catch: if any code path calls it again,
     `keys` fills up and the test says so. */
  const el: DrivableWebview & {
    ran: string[]; keys: string[]; back: boolean; forward: boolean;
    sendInputEvent: (e: { type: string; keyCode: string }) => void;
  } = {
    ran,
    keys,
    back: true,
    forward: false,
    loadURL: async () => {},
    goBack: () => { ran.push("goBack"); },
    goForward: () => { ran.push("goForward"); },
    canGoBack: () => el.back,
    canGoForward: () => el.forward,
    /* Recorded like the other navigations: a verb that says it reloaded has to
       have called something, and `ran` is where these tests look. */
    reload: () => { ran.push("reload"); },
    reloadIgnoringCache: () => { ran.push("reloadIgnoringCache"); },
    sendInputEvent: (e) => { keys.push(`${e.type}:${e.keyCode}`); },
    getURL: () => "https://example.com/app",
    getTitle: () => "The app",
    executeJavaScript: async (code: string) => { ran.push(code); return answer(code); },
    capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    // `open` waits for a navigation; these tests fire it immediately.
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (type === "did-stop-loading") queueMicrotask(() => fn(new Event(type)));
    },
    removeEventListener: () => {},
  };
  return el;
}

const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

/**
 * A guest that actually runs the code it is handed, against a real
 * `document.cookie` jar (domain-scoped to `host`) — instead of answering with
 * a canned value the way `fakeGuest` does. `cookies` builds its answer from
 * `document.cookie`'s own read-back, so a stand-in that never really writes
 * one would let a broken write report success forever.
 */
function fakeGuestWithCookies(host = "example.com") {
  const store = new Map<string, string>();
  const document = {
    get cookie() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(s: string) {
      const [nv, ...attrs] = s.split(";").map((p) => p.trim());
      const eq = nv.indexOf("=");
      if (eq === -1) return;
      let domain = host;
      for (const a of attrs) {
        const k = a.slice(0, a.indexOf("=")).toLowerCase();
        if (k === "domain") domain = a.slice(a.indexOf("=") + 1).replace(/^\./, "");
      }
      // A real browser drops a cookie whose domain does not match the page.
      if (domain !== host && !host.endsWith(`.${domain}`)) return;
      store.set(nv.slice(0, eq), nv.slice(eq + 1));
    },
  };
  return fakeGuest((code) => new Function("document", `return ${code}`)(document));
}

describe("driving a page", () => {
  test("open answers with where it ended up", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("open", { url: "https://example.com/app" }));
    expect(r).toEqual({ ok: true, value: { url: "https://example.com/app", title: "The app" } });
  });

  test("read brings back the page, capped", async () => {
    const el = fakeGuest(() => ({ url: "u", title: "t", text: "hello" }));
    const r = await runBrowserAsk(el, ask("read"));
    expect(r.ok).toBe(true);
    expect((r.value as any).text).toBe("hello");
    // The cap is in the code that runs in the page, not applied afterwards —
    // otherwise a huge page crosses the process boundary before being trimmed.
    expect(el.ran[0]).toContain(".slice(0, 20000)");
  });

  test("a selector is encoded, never pasted", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("click", { selector: `a[href="x"]` }));
    // JSON.stringify'd: the quotes inside the selector cannot close the string
    // literal this is embedded in.
    // The property is the ENCODED literal, not which of querySelector /
    // querySelectorAll happens to receive it — pinning the function name made
    // this lock fail on a change that never touched the escaping.
    // The property is the ENCODED literal, wherever it lands — it moved into a
    // variable when ids became acceptable selectors, and pinning the shape
    // failed a change that never touched the escaping.
    expect(el.ran[0]).toContain(String.raw`"a[href=\"x\"]"`);
  });

  test("clicking nothing is a failure, not a quiet success", async () => {
    const r = await runBrowserAsk(fakeGuest(() => false), ask("click", { selector: "#nope" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#nope");
  });

  test("typing goes through the native setter, or a framework discards it", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("type", { selector: "#q", text: "hola" }));
    const code = el.ran[0]!;
    expect(code).toContain("getOwnPropertyDescriptor");
    expect(code).toContain(`new Event("input"`);
    expect(code).toContain(`"hola"`);
    // Not submitted unless asked.
    expect(code).not.toContain("requestSubmit");
  });

  test("and submits when told to", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("type", { selector: "#q", text: "hola", submit: true }));
    expect(el.ran[0]).toContain("requestSubmit");
    expect((r.value as any).submitted).toBe(true);
  });

  test("wait polls inside the page and reports what it found", async () => {
    const found = await runBrowserAsk(fakeGuest(() => true), ask("wait", { selector: ".ready" }));
    expect(found.ok).toBe(true);
    const never = await runBrowserAsk(fakeGuest(() => false), ask("wait", { selector: ".ready" }));
    expect(never.ok).toBe(false);
    expect(never.error).toContain("never appeared");
  });

  test("a screenshot comes back as a data URL, with where it was taken", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("shot"));
    expect((r.value as any).png).toStartWith("data:image/png");
    expect((r.value as any).url).toBe("https://example.com/app");
  });

  test("the shell takes the screenshot when it can, because the element hangs", async () => {
    // Measured against the real app: `capturePage()` on the element never
    // resolves while the pane is behind another view — which is exactly when an
    // agent is driving it — so the shell's capture wins whenever it answers.
    const el = fakeGuest();
    el.capturePage = async () => { throw new Error("would have hung"); };
    const r = await runBrowserAsk(el, ask("shot"), async () => ({ png: "data:image/png;base64,FROMSHELL", why: "" }));
    expect((r.value as any).png).toBe("data:image/png;base64,FROMSHELL");
  });

  test("and the element still answers on a shell that cannot", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("shot"), async () => ({ png: null, why: "" }));
    expect((r.value as any).png).toStartWith("data:image/png");
  });

  test("--selector resolves a node, and NO route is asked to frame it", async () => {
    /*
     * The rectangle used to be pushed down to every capture route, and each
     * route framed the page to it — which meant overriding the page's device
     * metrics, which re-lays the page out, which moves everything the rectangle
     * was measured against. Measured on the running app: a crop of a 90x42
     * element came back 191x89 — the right SIZE, that element at this screen's
     * 2.125 — and completely blank. Reported as "the --selector captures come
     * back as blank crops".
     *
     * Now every route photographs the whole viewport, exactly as the person
     * sees it, and the rectangle is taken out of the PIXELS afterwards. Same
     * element, same page, after: the box, with its text in it.
     */
    const el = fakeGuest((code) => (code.includes("getBoundingClientRect")
      ? { kind: "ok", rect: { x: 10, y: 20, width: 300, height: 150 } }
      : { kind: "ok" }));
    const shellClips: unknown[] = [];
    const capturePageArgs: unknown[] = [];
    el.capturePage = async (rect?: unknown) => { capturePageArgs.push(rect); return { toDataURL: () => "data:image/png;base64,AAAA" }; };
    const r = await runBrowserAsk(el, ask("shot", { selector: "#e17" }), async (opts) => {
      shellClips.push((opts as { clip?: unknown } | undefined)?.clip);
      return { png: null, why: "" };
    });
    expect(r.ok).toBe(true);
    /* The lookup still happens — a selector that matches nothing is still a
       failure naming the selector, see the test below. */
    expect(el.ran.some((c) => c.includes("getBoundingClientRect"))).toBe(true);
    expect(shellClips[0], "the shell captures the viewport, not the rectangle").toBeUndefined();
    expect(capturePageArgs[0], "and so does the element's own capture").toBeUndefined();
  });

  test("--selector on nothing is a failure naming the selector, not a whole-page shot", async () => {
    const r = await runBrowserAsk(fakeGuest(() => ({ kind: "none" })), ask("shot", { selector: "#gone" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#gone");
  });

  test("--clip is passed straight through, no element lookup involved", async () => {
    const el = fakeGuest();
    const clip = { x: 0, y: 0, width: 400, height: 300 };
    const shellOpts: unknown[] = [];
    await runBrowserAsk(el, ask("shot", { clip }), async (opts) => { shellOpts.push(opts); return { png: null, why: "" }; });
    /* The rectangle is honoured by cropping the pixels, not by asking the page
       to become that shape — see the note on `--selector` above. */
    expect(shellOpts[0]).toEqual({ fullPage: false });
    // No round trip to the page to resolve a selector that was never given.
    expect(el.ran.some((c) => c.includes("getBoundingClientRect"))).toBe(false);
  });

  /* `--full-page` is gone: `captureBeyondViewport` repainted every sticky header
   once per strip, so the picture duplicated content. Make the viewport bigger
   with `resize` and take an ordinary shot instead. */

  test("--highlight draws a box in the page before capturing, and removes it after", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("shot", { highlight: "#e17", label: "still Online" }));
    expect(r.ok).toBe(true);
    const drew = el.ran.find((c) => c.includes("__agx_shot_highlight__"));
    expect(drew).toBeDefined();
    expect(drew).toContain("still Online");
    expect(el.ran.some((c) => c.includes("__agx_shot_highlight__") && c.includes(".remove()"))).toBe(true);
  });

  test("a highlight selector that matches nothing fails before any capture is attempted", async () => {
    const el = fakeGuest((code) => (code.includes("__agx_shot_highlight__") ? { kind: "none" } : { kind: "ok" }));
    let shellCalled = false;
    const r = await runBrowserAsk(el, ask("shot", { highlight: "#gone" }), async () => { shellCalled = true; return { png: null, why: "" }; });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#gone");
    expect(shellCalled).toBe(false);
  });

  test("an interrupted navigation is not a failed one", async () => {
    // Measured against the real app: replacing a page that was still loading
    // rejects loadURL with ERR_ABORTED (-3) — Chromium naming the navigation
    // this one replaced — while the new page loads perfectly well.
    const el = fakeGuest();
    el.loadURL = async () => { throw new Error("Error invoking remote method: Error: (-3) loading 'https://slow.example'"); };
    const r = await runBrowserAsk(el, ask("open", { url: "https://example.com/app" }));
    expect(r.ok).toBe(true);
  });

  test("but a real load failure still is", async () => {
    const el = fakeGuest();
    el.loadURL = async () => { throw new Error("ERR_NAME_NOT_RESOLVED"); };
    const r = await runBrowserAsk(el, ask("open", { url: "https://nope.example" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
  });

  test("a click says where it left you, because clicks navigate", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("click", { selector: "a" }));
    expect((r.value as any).url).toBe("https://example.com/app");
    expect((r.value as any).clicked).toBe("a");
  });

  test("a click that is covered fails with WHAT covers it, not just that it did", async () => {
    // §3: the actionability gate resolves inside the page to
    // { kind: "blocked", reason } for the four ways a click is not ready.
    // This stands in for the page saying that, since the gate itself only
    // runs for real inside Chromium — see the hostile-selector suite below
    // for proof the generated code is syntactically sound and safe to run.
    const el = fakeGuest(() => ({ kind: "blocked", reason: "covered by e42 .modal-backdrop" }));
    const r = await runBrowserAsk(el, ask("click", { selector: ".save" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("covered by e42 .modal-backdrop");
  });

  test("dblclick, rightclick and hover go through the same gate as click", async () => {
    for (const op of ["dblclick", "rightclick", "hover"]) {
      const ok = await runBrowserAsk(fakeGuest(), ask(op, { selector: ".target" }));
      expect(ok.ok, op).toBe(true);
      expect((ok.value as any)[op]).toBe(".target");
      const blocked = await runBrowserAsk(
        fakeGuest(() => ({ kind: "blocked", reason: "not visible" })),
        ask(op, { selector: ".target" }),
      );
      expect(blocked.ok, op).toBe(false);
      expect(blocked.error, op).toContain("not visible");
    }
  });

  test("check sets the checkbox through the native setter, like type does for value", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("check", { selector: "#agree", checked: true }));
    const code = el.ran[0]!;
    expect(code).toContain("checked");
    expect(code).toContain("wantOn = true");
  });

  test("check --off is unchecking, not a blind toggle", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("check", { selector: "#agree", checked: false }));
    expect(el.ran[0]).toContain("wantOn = false");
  });

  test("focus and blur act on the element without the actionability gate", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("focus", { selector: "#q" }));
    expect(el.ran[0]).toContain("e.focus()");
    expect(el.ran[0]).not.toContain("elementFromPoint");
    const r = await runBrowserAsk(el, ask("blur", { selector: "#q" }));
    expect(r.ok).toBe(true);
    expect(el.ran[1]).toContain("e.blur()");
  });

  test("fill sets every field in one call", async () => {
    const el = fakeGuest(() => ({ kind: "ok", filled: ["#name", "#email"] }));
    const r = await runBrowserAsk(el, ask("fill", { fields: { "#name": "Ada", "#email": "ada@example.com" } }));
    expect(r.ok).toBe(true);
    expect((r.value as any).filled).toEqual(["#name", "#email"]);
    expect(el.ran[0]).toContain("#name");
    expect(el.ran[0]).toContain("Ada");
    expect(el.ran[0]).toContain("#email");
  });

  test("fill says which field could not be filled", async () => {
    const el = fakeGuest(() => ({ kind: "none", selector: "#missing" }));
    const r = await runBrowserAsk(el, ask("fill", { fields: { "#missing": "x" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#missing");
  });

  test("going back reports where it landed", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("back"));
    expect(el.ran).toContain("goBack");
    expect(r.ok).toBe(true);
  });

  test("and refuses when there is nowhere to go, instead of doing nothing", async () => {
    // Electron's goBack() at the end of the history is a silent no-op, and an
    // agent that reads the same page twice concludes the page did not change.
    const el = fakeGuest();
    el.back = false;
    const r = await runBrowserAsk(el, ask("back"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing back");
    expect(el.ran).not.toContain("goBack");
  });

  test("text reads one element, and says so when there is none", async () => {
    const found = await runBrowserAsk(fakeGuest(() => ({ text: "Total: 41" })), ask("text", { selector: ".total" }));
    expect((found.value as any).text).toBe("Total: 41");
    const missing = await runBrowserAsk(fakeGuest(() => null), ask("text", { selector: ".total" }));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain(".total");
  });

  test("scroll answers with where it ended up, not just 'done'", async () => {
    const el = fakeGuest(() => ({ y: 900, atBottom: true }));
    const r = await runBrowserAsk(el, ask("scroll", { to: "bottom" }));
    expect(r.value).toEqual({ y: 900, atBottom: true });
    expect(el.ran[0]).toContain("document.body.scrollHeight");
    // Scrolling by pixels goes through scrollBy, and the number is a number.
    const by = fakeGuest(() => ({ y: 400, atBottom: false }));
    await runBrowserAsk(by, ask("scroll", { by: -250 }));
    expect(by.ran[0]).toContain("scrollBy({ top: -250 })");
  });

  /*
   * THE KEYBOARD, and the belief that had to be given up.
   *
   * This used to send the key through the shell — `sendInputEvent`, a real
   * key — on the grounds that a KeyboardEvent built in JavaScript is untrusted
   * and so moves no caret and submits no form. Both halves were true; the
   * conclusion was not, because the real key never arrived.
   *
   * Measured with a page that records what it receives: `press Backspace`
   * against a focused field left every character in place and produced ZERO
   * key events in the page. Listening in the app's OWN renderer at the same
   * time showed where they went — the app window got "keydown:Z" from a key
   * sent to the guest. An embedded page is not the widget that holds the
   * keyboard focus, and Chromium delivers synthesised input to the one that
   * does.
   *
   * So the events are made in the page, where they can be seen, and the EFFECT
   * an untrusted event does not have is applied by hand. That is the trade:
   * a page that only listens still hears the keystroke, and a field actually
   * changes.
   */
  test("a key is dispatched in the page, not sent to a widget that cannot get it", async () => {
    const el = fakeGuest(() => ({ kind: "ok", applied: "edit", prevented: false, on: "#q" }));
    await runBrowserAsk(el, ask("press", { key: "Escape" }));
    expect(el.keys, "the shell's keyboard does not reach a guest").toEqual([]);
    const src = el.ran[0] ?? "";
    expect(src).toContain("KeyboardEvent");
    expect(src).toContain('send("keydown")');
    expect(src).toContain('send("keyup")');
  });

  test("zoom moves the page, not just the number it reports", async () => {
    /*
     * Two implementations of this verb reported their own argument. The first
     * called setZoomFactor and read getZoomFactor back; the second called
     * setZoomLevel, which is what the panel's own Ctrl+/Ctrl- uses. Measured on
     * the running app, both times: 0.6, 0.7, 1.0 and 1.4 all left the page at
     * innerWidth 1314 and devicePixelRatio 1.4. A guest's zoom level is set and
     * then ignored — the scale it is drawn at comes from the window embedding
     * it.
     *
     * So it overrides the device metrics, and the number it answers with is
     * MEASURED from the page afterwards.
     */
    let natural = true;
    const el = fakeGuest(() => {
      // First read is the natural size, second is the size after the override.
      const out = natural ? { w: 1000, h: 800, dpr: 1 } : { w: 500 };
      natural = false;
      return JSON.stringify(out);
    });
    const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const r = await runBrowserAsk(el, ask("zoom", { factor: 2 }), undefined, undefined, undefined,
      async (method, params) => { cdpCalls.push({ method, params: (params ?? {}) as Record<string, unknown> }); return { ok: true, result: {} }; });
    // Cleared FIRST, or the "natural" size read back is its own last answer.
    expect(cdpCalls[0]?.method).toBe("Emulation.clearDeviceMetricsOverride");
    expect(cdpCalls[1]?.method).toBe("Emulation.setDeviceMetricsOverride");
    expect(cdpCalls[1]?.params.width).toBe(500);
    expect(cdpCalls[1]?.params.deviceScaleFactor).toBe(2);
    // 1000 natural / 500 after = 2. Measured, not echoed.
    expect((r.value as Record<string, unknown>)?.factor).toBe(2);
  });

  test("a tab an agent sized is not handed the person's level again", () => {
    /* The distinction is the clone's, from the run that found this; the
       mechanism is not — it re-applied the agent's factor with setZoomFactor,
       which a guest ignores. The override on the guest's own session survives
       a navigation by itself, so what this has to do is NOT undo it. */
    const claimed = { setZoomLevel: () => { levels.push("claimed"); } };
    const plain = { setZoomLevel: () => { levels.push("plain"); } };
    const levels: string[] = [];
    reapplyZoom(claimed, 2);
    expect(levels, "a tab nobody claimed still follows the window").toEqual(["claimed"]);
    // Claim it the way the verb does, then a navigation must leave it alone.
    claimAgentZoom(claimed, 2);
    reapplyZoom(claimed, 2);
    reapplyZoom(plain, 2);
    expect(levels).toEqual(["claimed", "plain"]);
    // And the person taking it back makes it an ordinary tab again.
    forgetAgentZoom(claimed);
    reapplyZoom(claimed, 2);
    expect(levels).toEqual(["claimed", "plain", "claimed"]);
  });

  test("intercept keeps its rules where the paused requests arrive", async () => {
    /*
     * It called Fetch.enable and wrote its rules into a variable in the page.
     * Fetch.enable pauses EVERY request until something answers it, and
     * nothing did — `Fetch.requestPaused` appeared nowhere in this repo. One
     * call and the tab stopped loading anything, matching URL or not, and
     * `--clear` did not bring it back: only Fetch.disable by hand did. That is
     * worse than a dead verb.
     */
    const el = fakeGuest();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const r = await runBrowserAsk(el, ask("intercept", { pattern: "/api", fulfill: true, status: 503, body: "no" }),
      undefined, undefined, undefined,
      async (method, params) => { calls.push({ method, params: (params ?? {}) as Record<string, unknown> }); return { ok: true, result: {} }; });
    // The rules reach the shell, and they reach it BEFORE the domain is turned
    // on: the other order is a window in which requests pause and nobody yet
    // knows what to do with them.
    expect(calls.map((c) => c.method)).toEqual(["Fetch.agxSetRules", "Fetch.enable"]);
    expect((calls[0]?.params.rules as unknown[])?.length).toBe(1);
    expect(el.ran.join(" "), "a rule in the page is a rule nothing reads").not.toContain("intercepts");
    expect((r.value as Record<string, unknown>)?.rules).toBe(1);
  });

  test("and clearing the last rule turns the domain off", async () => {
    const el = fakeGuest();
    const calls: string[] = [];
    const cdp = async (method: string) => { calls.push(method); return { ok: true, result: {} }; };
    await runBrowserAsk(el, ask("intercept", { pattern: "/api", abort: true }), undefined, undefined, undefined, cdp);
    calls.length = 0;
    await runBrowserAsk(el, ask("intercept", { pattern: "/api", clear: true }), undefined, undefined, undefined, cdp);
    // Fetch left enabled with no rules is every request paused for a match
    // that cannot happen.
    expect(calls).toEqual(["Fetch.agxSetRules", "Fetch.disable"]);
  });

  test("addInitScript says it ran now, because it does not survive a navigation", async () => {
    /* The protocol call promises "every new document from now on"; a <webview>
       guest does not keep them. Measured with the raw protocol: the script runs
       when asked for runImmediately and is gone after one navigation, reload or
       Page.navigate alike, and re-registering on did-start-navigation does not
       bring it back. The verb answered {"registered": ...} either way, so a
       caller that navigated was driving a page its setup had never touched. */
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("addInitScript", { name: "probe", js: "1" }),
      undefined, undefined, async () => ({ ok: true }));
    const v = r.value as Record<string, unknown>;
    expect(v?.ranNow).toBe(true);
    expect(String(v?.note)).toContain("navigation");
  });

  test("and a resize is a resize, not a lie told to window.innerWidth", async () => {
    /* This redefined innerWidth and innerHeight as properties on `window`: a
       script reading them saw the new number and nothing else changed — no
       reflow, no media query, no different screenshot. For a verb that exists
       so two shots of a page come out the same size, that is the opposite of
       what it promises. */
    const el = fakeGuest(() => JSON.stringify({ w: 390, h: 844 }));
    const cdpCalls: string[] = [];
    const r = await runBrowserAsk(el, ask("resize", { width: 390, height: 844 }), undefined, undefined, undefined,
      async (method) => { cdpCalls.push(method); return { ok: true, result: {} }; });
    expect(cdpCalls).toContain("Emulation.setDeviceMetricsOverride");
    expect(el.ran.join(" "), "no property is redefined on window").not.toContain("defineProperty");
    expect((r.value as Record<string, unknown>)?.width).toBe(390);
  });

  test("and the effect a synthetic key does not have is applied by hand", async () => {
    const el = fakeGuest(() => ({ kind: "ok", applied: "edit", prevented: false, on: "#q" }));
    const r = await runBrowserAsk(el, ask("press", { key: "Backspace" }));
    const src = el.ran[0] ?? "";
    // The editing keys a form actually needs, and the input event a framework
    // listens for — a value assigned behind React's back snaps straight back.
    expect(src).toContain("deleteContentBackward");
    expect(src).toContain("insertText");
    expect(src).toContain("InputEvent");
    // A page that cancels the key is obeyed, and the answer says so rather
    // than reporting a press that did nothing.
    expect(src).toContain("prevented");
    expect((r.value as Record<string, unknown>)?.applied).toBe("edit");
  });

  test("an empty capture is a failure, not a zero-byte screenshot", async () => {
    // Measured twice against the real app: a pane hidden behind another view
    // produces no frames, both captures come back blank, and this used to
    // answer ok with `data:image/png;base64,` — the CLI then wrote an empty
    // file and printed its path. An agent reports on a screenshot that is not
    // there.
    const el = fakeGuest();
    el.capturePage = async () => ({ toDataURL: () => "data:image/png;base64," });
    const r = await runBrowserAsk(el, ask("shot"), async () => ({ png: null, why: "" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not on screen");
  });

  test("a capture that never comes back is an answer too, not a hang", async () => {
    // Measured: `stayHidden` is the flag for "render this anyway", and with
    // nothing to render from it does not fail — it waits. Every other verb
    // answered instantly while `shot` sat until the server gave up, which reads
    // as a broken browser rather than as a pane that is not showing.
    const el = fakeGuest();
    el.capturePage = () => new Promise(() => {}) as Promise<{ toDataURL(): string }>;
    const started = Date.now();
    const r = await runBrowserAsk(el, ask("shot"), () => new Promise(() => {}));
    expect(r.ok).toBe(false);
    // The reason is the shell's own now — "it did not answer in time" — which
    // is what actually happened, rather than the one sentence every failure
    // used to borrow.
    expect(r.error).toContain("did not answer in time");
    /* The bound is "it answers", and it is bounded by the relay: a screenshot
       is given twenty seconds there, so everything here — the shell twice, with
       a resize between, then the element — has to land inside that. What must
       never happen is the verb hanging until the server gives up and tells an
       agent the browser has died. */
    expect(Date.now() - started).toBeLessThan(19_000);
  }, 30_000);

  test("a page that throws is an answer, not a crashed panel", async () => {
    const el = fakeGuest();
    el.executeJavaScript = async () => { throw new Error("Script failed to execute"); };
    const r = await runBrowserAsk(el, ask("read"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Script failed");
  });

  test("addInitScript hands the name and script straight to the shell", async () => {
    const seen: Array<[string, string]> = [];
    const register = async (name: string, source: string) => { seen.push([name, source]); return { ok: true }; };
    const r = await runBrowserAsk(fakeGuest(), ask("addInitScript", { name: "sealClock", js: "Date.now = () => 0;" }),
      undefined, undefined, register);
    expect((r.value as Record<string, unknown>)?.registered).toBe("sealClock");
    expect(seen).toEqual([["sealClock", "Date.now = () => 0;"]]);
  });

  test("registering the same name again is what REPLACES it — the shell decides, this just asks", async () => {
    const seen: string[] = [];
    const register = async (name: string) => { seen.push(name); return { ok: true }; };
    await runBrowserAsk(fakeGuest(), ask("addInitScript", { name: "x", js: "1" }), undefined, undefined, register);
    await runBrowserAsk(fakeGuest(), ask("addInitScript", { name: "x", js: "2" }), undefined, undefined, register);
    // Both calls reach the shell under the SAME key; there is no second name
    // minted here to keep two registrations alive side by side.
    expect(seen).toEqual(["x", "x"]);
  });

  test("the shell's refusal is the verb's failure", async () => {
    const register = async () => ({ ok: false, error: "no debugger session for this tab" });
    const r = await runBrowserAsk(fakeGuest(), ask("addInitScript", { name: "x", js: "1" }), undefined, undefined, register);
    expect(r).toEqual({ ok: false, error: "no debugger session for this tab" });
  });

  test("expose registers a wrapper under its own key, so it never collides with a plain addInitScript of the same name", async () => {
    const seen: Array<[string, string]> = [];
    const register = async (name: string, source: string) => { seen.push([name, source]); return { ok: true }; };
    const r = await runBrowserAsk(fakeGuest(), ask("expose", { name: "reportBug" }), undefined, undefined, register);
    expect(r).toEqual({ ok: true, value: { exposed: "reportBug" } });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe("__expose_reportBug");
    expect(seen[0][1]).toContain("window[\"reportBug\"]");
  });

  test("a call the page makes to an exposed function lands in the same buffer console/network already read", async () => {
    let source = "";
    const register = async (_name: string, s: string) => { source = s; return { ok: true }; };
    await runBrowserAsk(fakeGuest(), ask("expose", { name: "reportBug" }), undefined, undefined, register);
    // Run the generated wrapper for real, against a stand-in `window`, then
    // call it the way the page would — the point is that the buffer it left
    // behind is exactly what `exposed` reads.
    const win: Record<string, unknown> = { __agxLog: undefined };
    new Function("window", `${source}`)(win);
    (win.reportBug as (...a: unknown[]) => void)("hello", 42);
    const buf = (win.__agxLog as { exposed: Array<{ name: string; args: unknown[]; at: number }> }).exposed;
    expect(buf).toEqual([{ name: "reportBug", args: ["hello", 42], at: buf[0]!.at }]);
  });

  test("exposed reads the buffer since a timestamp, same shape as console/network", async () => {
    const el = fakeGuest(() => ({ rows: [{ name: "reportBug", args: [1], at: 5 }], dropped: 0, now: 9 }));
    const r = await runBrowserAsk(el, ask("exposed", { since: 4, limit: 10 }));
    expect(r.ok).toBe(true);
    expect(el.ran[0]).toContain("window.__agxLog && window.__agxLog.exposed");
    expect(el.ran[0]).toContain("r.at > 4");
  });
});

/*
 * The selector and the typed text are the only outside strings that reach a
 * literal in code this file builds, and they arrive over the wire from an
 * agent. The server's gate (server/src/browserdrive.ts) refuses a newline, a
 * carriage return and a NUL in a selector and lets everything else through —
 * including U+2028 and U+2029, which JSON.stringify leaves bare and which were
 * line terminators to a JS parser. So the lock is not "we called the right
 * helper": it runs what the panel built and checks nothing escaped.
 */
describe("a hostile selector stays data", () => {
  const PAYLOADS: Array<[string, string]> = [
    ["a double quote", 'a"]'],
    ["a quote break-out", 'x"); globalThis.__canary.hit = 1; ("'],
    ["a trailing backslash", "a\\"],
    ["a backslash before a quote", 'a\\"; globalThis.__canary.hit = 1; //'],
    ["U+2028 and code after it", "a\u2028globalThis.__canary.hit = 1;//"],
    ["U+2029 and code after it", "a\u2029globalThis.__canary.hit = 1;//"],
    ["a closing script tag", '</script><img src=x onerror="globalThis.__canary.hit = 1">'],
    ["a template literal", "a`${globalThis.__canary.hit = 1}`"],
    ["a comment close", "a*/ globalThis.__canary.hit = 1; /*"],
    ["a lone surrogate", "a\uD800b"],
  ];
  const VERBS = ["click", "type", "wait", "text", "scroll"];

  /** Run the built code for real, with a querySelector that records exactly
   *  what it was handed. Evaluating it is the point: asserting on the shape of
   *  the string would pass for any escaping that merely looks careful. */
  function run(code: string) {
    const seen: string[] = [];
    // `querySelectorAll` as well as `querySelector`: the verbs resolve through
    // the plural now, and a stand-in that lacks it throws INSIDE resolveOne's
    // own try/catch — which would swallow the throw, record nothing, and leave
    // this lock green while measuring nothing at all. It answers with one
    // element so the body runs for real, which is the half that matters: the
    // payload must reach the selector AND must not execute on the way.
    const el = { scrollIntoView: () => {}, click: () => {}, focus: () => {},
      dispatchEvent: () => true, tagName: "A", id: "", getAttribute: () => null,
      value: "", form: null, scrollIntoViewIfNeeded: () => {}, disabled: false,
      className: "", contains: (n: unknown) => n === el,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 1, height: 1 }) };
    const doc = {
      querySelector: (s: string) => { seen.push(s); return null; },
      querySelectorAll: (s: string) => { seen.push(s); return [el]; },
      body: { innerText: "", scrollHeight: 100 },
      title: "",
      // `click`'s actionability gate (§3) resolves it via elementFromPoint —
      // answered with the element itself so the gate says "ok" here and the
      // assertions below are about the selector, not about this stand-in.
      elementFromPoint: () => el,
    };
    const win = { scrollTo: () => {}, scrollBy: () => {}, scrollY: 0, innerHeight: 10 };
    const getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
    const innerWidth = 1000, innerHeight = 800;
    // `type` reaches for the native value setter through these two, because a
    // framework ignores a value assigned behind its back. They are globals in a
    // page and nothing at all inside `new Function`, so the body threw before
    // reaching the assertion — the payload was never the thing failing.
    const setter = { value: "" };
    const proto = Object.defineProperty({}, "value", {
      configurable: true, set(v: string) { setter.value = v; }, get: () => setter.value,
    });
    const Input = function () {} as unknown as { prototype: object };
    Input.prototype = proto;
    // `wait` and `click`'s actionability gate poll on a timer; a no-op
    // setTimeout stops either after one look.
    new Function(
      "document", "window", "location", "setTimeout", "HTMLInputElement", "HTMLTextAreaElement", "Event",
      "getComputedStyle", "innerWidth", "innerHeight",
      `return ${code}`,
    )(
      doc, win, { href: "about:blank" }, () => 0, Input, Input,
      class { constructor(public type: string) {} },
      getComputedStyle, innerWidth, innerHeight,
    );
    return seen;
  }

  for (const [name, payload] of PAYLOADS) {
    test(`${name} reaches querySelector verbatim and runs nothing`, async () => {
      for (const op of VERBS) {
        const el = fakeGuest(() => false);
        const g = globalThis as unknown as { __canary: { hit: number } };
        g.__canary = { hit: 0 };
        await runBrowserAsk(el, ask(op, { selector: payload, text: payload, submit: false }));
        const code = el.ran.find((c) => c.includes("querySelector"));
        expect(code, `${op} built no querySelector`).toBeDefined();
        expect(run(code!), `${op} did not receive the selector whole`).toEqual([payload]);
        expect(g.__canary.hit, `${op} let the payload execute`).toBe(0);
        // Nothing that could end a string, a line or a script element survives
        // into the source — the property `jsLit` exists to hold.
        expect(code).not.toContain("\u2028");
        expect(code).not.toContain("\u2029");
        expect(code!.slice(code!.indexOf("querySelector"))).not.toContain("<");
      }
    });
  }

  /*
   * `expose`'s name is meant to be a bare identifier — the server's own gate
   * (`okName` in server/src/browserdrive.ts) refuses anything else before it
   * gets here. But this module does not get to assume the gate upstream held;
   * every other verb in this file re-checks its own string for exactly that
   * reason, and `expose` builds a literal out of `name` the same way `click`
   * and `type` build one out of a selector.
   */
  for (const [name, payload] of PAYLOADS) {
    test(`expose's name (${name}) reaches window[...] verbatim and runs nothing`, async () => {
      const g = globalThis as unknown as { __canary: { hit: number } };
      g.__canary = { hit: 0 };
      let source = "";
      const register = async (_n: string, s: string) => { source = s; return { ok: true }; };
      await runBrowserAsk(fakeGuest(), ask("expose", { name: payload }), undefined, undefined, register);
      const win: Record<string, unknown> = {};
      // Defining the wrapper must not run the payload, and neither must
      // calling it: both are where a name spliced in rather than encoded
      // would break out.
      new Function("window", `${source}`)(win);
      (win[payload] as (...a: unknown[]) => void)?.("x");
      expect(g.__canary.hit, `expose let the name execute`).toBe(0);
      expect(source).not.toContain(" ");
      expect(source).not.toContain(" ");
      expect(source.slice(source.indexOf("window["))).not.toContain("<");
    });
  }

  /*
   * And the shell's reason, when the shell has one.
   *
   * "The pane is not on screen" was reported for every failure — including the
   * one where the pane is perfectly visible and the INSPECTOR holds the
   * debugger. Two people went looking in the wrong place for it, one of them
   * twice.
   */
  test("a shell that says why gets to say why", async () => {
    const el = fakeGuest();
    el.capturePage = async () => ({ toDataURL: () => "data:image/png;base64," });
    const r = await runBrowserAsk(el, ask("shot"), async () => ({ png: null, why: "the inspector is attached to this page" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("inspector");
  });
});

describe("§6: faking the network", () => {
  test("registering a fake injects the collector and pushes a rule keyed by pattern", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("fake", { pattern: "/api/board", status: 500 }));
    expect(r.ok).toBe(true);
    expect((r.value as any).faking).toBe("/api/board");
    expect((r.value as any).timeout).toBe(false);
    // The collector goes in first — a fake registered before any navigation
    // still needs somewhere on the page to live.
    expect(el.ran[0]).toContain("__agxLog");
    const pushed = el.ran[1]!;
    expect(pushed).toContain('"/api/board"');
    expect(pushed).toContain("status: 500");
    expect(pushed).toContain("timeout: false");
    // Same pattern registered twice replaces, rather than stacking two rules
    // that would both try to answer the same request.
    expect(pushed).toContain("filter((f) => f.pattern !==");
  });

  test("a timeout fake carries timeout, not a status", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("fake", { pattern: "/api/board", timeout: true }));
    expect(r.ok).toBe(true);
    expect((r.value as any).timeout).toBe(true);
    expect(el.ran[1]).toContain("timeout: true");
    expect(el.ran[1]).toContain("status: undefined");
  });

  test("delay and body ride along, encoded rather than pasted", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("fake", {
      pattern: `"quoted"`, status: 404, body: "not found", delayMs: 250,
    }));
    const pushed = el.ran[1]!;
    expect(pushed).toContain("delayMs: 250");
    expect(pushed).toContain('"not found"');
    // The pattern is encoded, never pasted — a pattern carrying a quote must
    // not be able to close the string literal it is embedded in.
    expect(pushed).toContain(String.raw`"\"quoted\""`);
  });

  test("clearing a fake filters it out by pattern rather than registering a new one", async () => {
    const el = fakeGuest(() => true);
    const r = await runBrowserAsk(el, ask("fake", { pattern: "/api/board", clear: true }));
    expect(r.ok).toBe(true);
    expect((r.value as any).cleared).toBe("/api/board");
    expect((r.value as any).wasActive).toBe(true);
    expect(el.ran[1]).toContain("filter((f) => f.pattern !==");
    expect(el.ran[1]).not.toContain("log.fakes.push");
  });
});

describe("the DevTools verbs built on the protocol", () => {
  /* A stand-in protocol, which is the only way these are testable at all: a
     real one needs Electron, a guest process and the single debugger seat a
     page has. */
  function fakeCdp(answers: Record<string, unknown> = {}) {
    const sent: Array<{ method: string; params?: unknown }> = [];
    const cdp = async (method: string, params?: unknown) => {
      sent.push({ method, params });
      return method in answers
        ? { ok: true, result: answers[method] }
        : { ok: true, result: {} };
    };
    return { cdp, sent };
  }

  test("listeners resolves the node first, because CDP wants an object id", async () => {
    const f = fakeCdp({
      "Runtime.evaluate": { result: { objectId: "obj-1" } },
      "DOMDebugger.getEventListeners": { listeners: [{ type: "click", scriptId: "7", lineNumber: 42 }] },
    });
    const r = await runBrowserAsk(fakeGuest(), ask("listeners", { selector: "#save" }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(true);
    expect((r.value as any).listeners[0].type).toBe("click");
    // One verb, not four: resolve then read, in the same round trip.
    expect(f.sent.map((s) => s.method))
      .toEqual(["Runtime.evaluate", "DOMDebugger.getEventListeners"]);
  });

  test("and says nothing matched rather than handing back an empty list", async () => {
    // An empty listener list and a selector that matched nothing look
    // identical to a caller, and only one of them is worth acting on.
    const f = fakeCdp({ "Runtime.evaluate": { result: { subtype: "null" } } });
    const r = await runBrowserAsk(fakeGuest(), ask("listeners", { selector: "#gone" }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#gone");
  });

  test("coverage summarises, because a raw dump would live in the context all session", async () => {
    const f = fakeCdp({
      "Profiler.takePreciseCoverage": {
        result: [{
          url: "http://localhost/build.js",
          functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 100, endOffset: 400, count: 0 }] }],
        }],
      },
      "CSS.stopRuleUsageTracking": { ruleUsage: [{ styleSheetId: "1", used: true }, { styleSheetId: "2", used: false }] },
    });
    const r = await runBrowserAsk(fakeGuest(), ask("coverage", { action: "stop" }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(true);
    const v = r.value as any;
    expect(v.js[0]).toEqual({ url: "http://localhost/build.js", usedBytes: 100, totalBytes: 400 });
    expect(v.css).toEqual({ rules: 2, used: 1 });
  });

  test("starting coverage records both languages, or it answers half the question", async () => {
    const f = fakeCdp();
    await runBrowserAsk(fakeGuest(), ask("coverage", { action: "start" }),
      undefined, undefined, undefined, f.cdp);
    const methods = f.sent.map((s) => s.method);
    expect(methods).toContain("Profiler.startPreciseCoverage");
    expect(methods, "CSS coverage was never started").toContain("CSS.startRuleUsageTracking");
  });
});

describe("§8: the virtual clock", () => {
  /* Same stand-in as the DevTools verbs above — this whole feature is built
     on the protocol, so it is testable the same way. */
  function fakeCdp(answers: Record<string, unknown> = {}) {
    const sent: Array<{ method: string; params?: unknown }> = [];
    const cdp = async (method: string, params?: unknown) => {
      sent.push({ method, params });
      return method in answers ? { ok: true, result: answers[method] } : { ok: true, result: {} };
    };
    return { cdp, sent };
  }

  test("freezeAnimations injects a stylesheet the page cannot out-rank", async () => {
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("clock", { freezeAnimations: true }));
    expect(r.ok).toBe(true);
    expect((r.value as any).animationsFrozen).toBe(true);
    expect(el.ran.some((c) => c.includes("__agxFreezeAnim"))).toBe(true);
  });

  test("seal registers Math.random for future navigations AND patches the page already loaded", async () => {
    const seen: Array<[string, string]> = [];
    const register = async (name: string, source: string) => { seen.push([name, source]); return { ok: true }; };
    const el = fakeGuest();
    const r = await runBrowserAsk(el, ask("clock", { seal: true }), undefined, undefined, register);
    expect(r.ok).toBe(true);
    expect((r.value as any).randomSealed).toBe(true);
    expect(seen).toEqual([["__agxSealRandom", expect.any(String)]]);
    // Registering alone would only take effect on the NEXT navigation — this
    // page is already loaded, so it needs the same script applied directly.
    expect(el.ran.some((c) => c.includes("__agxRandomSealed"))).toBe(true);
  });

  test("a shell that cannot register an init script fails seal outright, not silently", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("clock", { seal: true }));
    expect(r).toEqual({ ok: false, error: "this shell cannot register an init script" });
  });

  test("advanceMs advances virtual time and waits on the PAGE's own clock, not the host's", async () => {
    let calls = 0;
    const el = fakeGuest((code) => {
      if (code === "Date.now()") { calls++; return calls === 1 ? 1000 : 31000; }
      return { kind: "ok" };
    });
    const f = fakeCdp();
    const r = await runBrowserAsk(el, ask("clock", { advanceMs: 30_000 }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(true);
    expect((r.value as any).advancedMs).toBe(30_000);
    expect(f.sent).toEqual([
      { method: "Emulation.setVirtualTimePolicy", params: { policy: "advance", budget: 30_000 } },
    ]);
  });

  test("waitFor: networkIdle is CDP's own pause-for-fetches policy, not a wait built here", async () => {
    let calls = 0;
    const el = fakeGuest((code) => {
      if (code === "Date.now()") { calls++; return calls === 1 ? 0 : 5000; }
      return { kind: "ok" };
    });
    const f = fakeCdp();
    await runBrowserAsk(el, ask("clock", { advanceMs: 5000, waitFor: "networkIdle" }),
      undefined, undefined, undefined, f.cdp);
    expect(f.sent[0]).toEqual({
      method: "Emulation.setVirtualTimePolicy",
      params: { policy: "pauseIfNetworkFetchesPending", budget: 5000 },
    });
  });

  /*
   * The thing worth naming in the commit: a page polling on setInterval never
   * reads zero here, because the interval re-arms itself — the counter is
   * right, not broken. `waitFor: "noTimers"` REPORTS this after the jump; it
   * does not change what the jump did.
   */
  test("waitFor: noTimers reports what's still scheduled after the jump — a poller never reads zero", async () => {
    let calls = 0;
    const el = fakeGuest((code) => {
      if (code === "Date.now()") { calls++; return calls === 1 ? 0 : 10_000; }
      if (code.includes("pendingTimers")) return 2;
      return { kind: "ok" };
    });
    const f = fakeCdp();
    const r = await runBrowserAsk(el, ask("clock", { advanceMs: 10_000, waitFor: "noTimers" }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(true);
    expect((r.value as any).pendingTimers).toBe(2);
  });
});

describe("§13: the settings, as an API", () => {
  function fakeCdp(answers: Record<string, unknown> = {}) {
    const sent: Array<{ method: string; params?: unknown }> = [];
    const cdp = async (method: string, params?: unknown) => {
      sent.push({ method, params });
      return method in answers ? { ok: true, result: answers[method] } : { ok: true, result: {} };
    };
    return { cdp, sent };
  }

  test("get answers with what was last set, not with a guess — and says the answer is one tab's", async () => {
    resetBrowserSettings();
    const r = await runBrowserAsk(fakeGuest(), ask("settings", { action: "get" }));
    expect(r).toEqual({ ok: true, value: { cache: "normal", ignoreCertErrors: false, blocked: {}, scope: "tab" } });
  });

  /*
   * ONE TAB, ASKED TWICE. This test used to call `fakeGuest()` a second time
   * for the read-back and pass — which is the §14 defect stated as an
   * assertion: settings set on one webview were read back from a DIFFERENT
   * one, because the ledger was a module global. It passes now only because
   * the same element is asked both times.
   */
  test("cache reaches Network.setCacheDisabled and is remembered for the next get on that tab", async () => {
    resetBrowserSettings();
    const f = fakeCdp();
    const el = fakeGuest();
    const set = await runBrowserAsk(el, ask("settings", { action: "set", cache: "bypass" }),
      undefined, undefined, undefined, f.cdp);
    expect(set).toEqual({ ok: true, value: { applied: ["cache"] } });
    expect(f.sent).toEqual([{ method: "Network.setCacheDisabled", params: { cacheDisabled: true } }]);
    const got = await runBrowserAsk(el, ask("settings", { action: "get" }));
    expect((got.value as any).cache).toBe("bypass");
  });

  /*
   * §14, THE WHOLE POINT. Two agents, two tabs. `settings set` is three CDP
   * commands against ONE guest's debugger session, so a ledger held per window
   * described one tab and reported it as the browser's: A turned certificate
   * validation off on its own page and B's `settings get` answered that B had
   * it off too — which is a security posture reported wrong, in the direction
   * that says "safer than you are".
   *
   * Breaking it on purpose: put `mine` back to one shared object in
   * browserDrive.ts and B reads `bypass` / `true` here.
   */
  test("two tabs keep two ledgers — A's overrides are not reported as B's", async () => {
    resetBrowserSettings();
    const f = fakeCdp();
    const a = fakeGuest();
    const b = fakeGuest();
    await runBrowserAsk(a, ask("settings", { action: "set", cache: "bypass", ignoreCertErrors: true }),
      undefined, undefined, undefined, f.cdp);
    const mine = await runBrowserAsk(a, ask("settings", { action: "get" }));
    const theirs = await runBrowserAsk(b, ask("settings", { action: "get" }));
    expect((mine.value as any).cache).toBe("bypass");
    expect((mine.value as any).ignoreCertErrors).toBe(true);
    expect((theirs.value as any).cache).toBe("normal");
    expect((theirs.value as any).ignoreCertErrors).toBe(false);
  });

  test("ignoreCertErrors enables the Security domain before setting it", async () => {
    resetBrowserSettings();
    const f = fakeCdp();
    await runBrowserAsk(fakeGuest(), ask("settings", { action: "set", ignoreCertErrors: true }),
      undefined, undefined, undefined, f.cdp);
    expect(f.sent).toEqual([
      { method: "Security.enable", params: {} },
      { method: "Security.setIgnoreCertificateErrors", params: { ignore: true } },
    ]);
  });

  test("blocking images and blocking JS on the same origin end up in ONE call, not two", async () => {
    resetBrowserSettings();
    const f = fakeCdp();
    // The SAME tab twice: the block list is that guest's, so accumulating it
    // across two different webviews was the module-global bug, not the feature.
    const el = fakeGuest();
    await runBrowserAsk(el, ask("settings", { action: "set", block: { origin: "example.com", images: true } }),
      undefined, undefined, undefined, f.cdp);
    // A second call for the same origin must not drop the first origin's patterns.
    const second = await runBrowserAsk(el, ask("settings", { action: "set", block: { origin: "example.com", js: true } }),
      undefined, undefined, undefined, f.cdp);
    expect(second.ok).toBe(true);
    const lastCall = f.sent[f.sent.length - 1];
    expect(lastCall.method).toBe("Network.setBlockedURLs");
    const urls = (lastCall.params as { urls: string[] }).urls;
    expect(urls).toContain("*://example.com/*.png");
    expect(urls).toContain("*://example.com/*.js");
  });

  test("blocking neither images nor js for an origin clears its entry", async () => {
    resetBrowserSettings();
    const f = fakeCdp();
    const el = fakeGuest();
    await runBrowserAsk(el, ask("settings", { action: "set", block: { origin: "example.com", images: true } }),
      undefined, undefined, undefined, f.cdp);
    await runBrowserAsk(el, ask("settings", { action: "set", block: { origin: "example.com", images: false } }),
      undefined, undefined, undefined, f.cdp);
    const got = await runBrowserAsk(el, ask("settings", { action: "get" }));
    expect((got.value as any).blocked).toEqual({});
    expect(f.sent[f.sent.length - 1]).toEqual({ method: "Network.setBlockedURLs", params: { urls: [] } });
  });

  /*
   * `internalPage`, NOT `page` — the rename §14 needed.
   *
   * `page` here used to mean "the internal page this webview renders", which
   * collided with the `page` every other verb uses for WHICH TAB. That
   * collision is the whole reason `settings` was denied a tab id, and while it
   * stood, `settings set --page blank` blanked whichever tab was in front.
   * The panel now reads only the new name; the server still accepts the old
   * spelling on the wire and hands it over as `internalPage`.
   */
  test("internalPage: blank navigates THIS guest there, without the http(s)-only gate `open` has", async () => {
    resetBrowserSettings();
    const loaded: string[] = [];
    const el = fakeGuest();
    el.loadURL = async (url: string) => { loaded.push(url); };
    const r = await runBrowserAsk(el, ask("settings", { action: "set", internalPage: "blank" }));
    expect(r).toEqual({ ok: true, value: { applied: ["internalPage"] } });
    expect(loaded).toEqual(["about:blank"]);
  });

  test("a tab id in `page` is not a navigation instruction — it says which tab, and blanks nothing", async () => {
    resetBrowserSettings();
    const loaded: string[] = [];
    const el = fakeGuest();
    el.loadURL = async (url: string) => { loaded.push(url); };
    const f = fakeCdp();
    const r = await runBrowserAsk(el, ask("settings", { action: "set", cache: "bypass", page: "t7-orbit" }),
      undefined, undefined, undefined, f.cdp);
    expect(r.ok).toBe(true);
    expect(loaded).toEqual([]);
  });
});

describe("a refusal that names several elements has to tell them apart", () => {
  /*
   * FOUND BY RUNNING IT. On a real page, "selector matched 2 elements — p, p"
   * is what came back: true, and no help whatsoever to somebody being asked to
   * narrow the selector. The description was tag + id + testid, and a page
   * whose elements have neither of the last two describes every match
   * identically.
   *
   * Position always distinguishes, so it always appears. The trimmed text is
   * what a person actually recognises when they look at the page.
   */
  test("the samples carry position and text, not just the tag", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("click", { selector: "p" }));
    const built = el.ran.find((c) => c.includes("__describe")) ?? "";
    expect(built, "no describe was built at all").not.toBe("");
    expect(built, "position is what always distinguishes").toContain("nth-of-type");
    expect(built, "text is what a person recognises").toContain("innerText");
  });
});

describe("stable ids, and what is hiding a thing", () => {
  /*
   * §2 and §17. "Do not force people to invent CSS selectors when stable ids
   * can be given" is listed as an anti-feature, and the tree handed back names
   * without ever giving anything to address them by.
   */
  test("the tree stamps an id ON the node, so it survives a re-render", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("observe", {}));
    const built = el.ran.join("\n");
    expect(built, "nothing stamps an id").toContain("dataset.agxE");
    // A counter on the page, so two observations of the same element agree.
    expect(built).toContain("__agxSeq");
  });

  test("a hidden element is REPORTED, not silently skipped", async () => {
    /*
     * It used to `continue` on a zero-sized box, so an element that is there
     * and hidden looked exactly like an element that does not exist. Those are
     * opposite findings: one is a bug in the page, the other is a wrong
     * selector, and the caller could not tell them apart.
     */
    const el = fakeGuest();
    await runBrowserAsk(el, ask("observe", {}));
    const built = el.ran.join("\n");
    expect(built).toContain("display:none");
    expect(built).toContain("visibility:hidden");
    expect(built).toContain("opacity:0");
  });

  test("and it names what covers it, not just that something does", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("observe", {}));
    expect(el.ran.join("\n"), "no elementFromPoint, so nothing can name the coverer")
      .toContain("elementFromPoint");
  });

  test("an id from an observation is accepted wherever a selector is", async () => {
    // Handing back e17 and then refusing it as a selector would be the
    // anti-feature with extra steps.
    const el = fakeGuest();
    await runBrowserAsk(el, ask("click", { selector: "e17" }));
    expect(el.ran[0]).toContain("data-agx-e");
  });

  test("storage comes back as KEYS, never values", async () => {
    // A token in localStorage is exactly what §16 exists to keep out of a log,
    // and the key alone answers "is it logged in".
    const el = fakeGuest();
    await runBrowserAsk(el, ask("observe", {}));
    const built = el.ran.join("\n");
    expect(built).toContain("Object.keys(localStorage)".replace("localStorage)", "s2)"));
    expect(built).toContain("cookieNames");
  });

  test("a pending dialog is reported, because it is why nothing else answers", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("observe", {}));
    expect(el.ran.join("\n")).toContain("__agxDialog");
  });
});

describe("failures that say something", () => {
  /*
   * Both found by USING it, right after §15 shipped, and both are the exact
   * shape §15 exists to abolish.
   */
  test("eval catches the throw in the page, where it is legible", async () => {
    const el = fakeGuest();
    await runBrowserAsk(el, ask("eval", { js: "boom()" }));
    const built = el.ran[0] ?? "";
    /*
     * An exception crossing the webview bridge arrives as "Error invoking
     * remote method GUEST_VIEW_MANAGER_CALL … check the renderer console" —
     * and an agent cannot check the renderer console.
     */
    expect(built, "the throw is left to cross the bridge").toContain("catch");
    expect(built, "no message is carried back").toContain("__agxErr");
    // With a couple of stack frames, because "it threw" and "it threw HERE"
    // are different amounts of help.
    expect(built).toContain("stack");
  });

  test("open reports not moving, instead of answering with where it already was", async () => {
    /*
     * The guest guard refuses data:, file: and blob: — rightly. `loadURL` does
     * not reject when it does, so this used to answer ok with the URL it was
     * ALREADY on: ask for A, get B, be told yes. Measured with three data:
     * URLs in a row, each reporting success, the page never moving.
     */
    const el = fakeGuest();
    // getURL is fixed in the stand-in, so any navigation "fails to move".
    const r = await runBrowserAsk(el, ask("open", { url: "data:text/html,<b>hi</b>" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not navigate");
    // And it names the likely reason rather than leaving it to be guessed.
    expect(r.error).toContain("data:");
  });
});

describe("eval's wrapper stays synchronous unless asked", () => {
  /*
   * A REGRESSION THIS FILE DID NOT CATCH, which is the reason it is here.
   *
   * Making the wrapper `async` unconditionally broke every eval, `1+1`
   * included, on every page. A webview's executeJavaScript handles a
   * promise-returning script differently from a plain one — and the stand-in
   * guest here accepts any string, so ninety tests stayed green while the verb
   * was dead in the real app.
   *
   * The property is cheap to state and would have caught it: a plain eval must
   * not produce an async function.
   */
  test("a plain eval builds no async wrapper", async () => {
    const el = fakeGuest(() => ({ __agxOk: true, __agxV: 2 }));
    await runBrowserAsk(el, ask("eval", { js: "1+1" }));
    expect(el.ran[0], "a plain eval went out as an async IIFE").not.toContain("async");
  });

  test("and --await does, because that is what it is for", async () => {
    const el = fakeGuest(() => ({ __agxOk: true, __agxV: 2 }));
    await runBrowserAsk(el, ask("eval", { js: "fetch('/x')", await: true }));
    expect(el.ran[0]).toContain("async");
    expect(el.ran[0]).toContain("await");
  });

  /*
   * THE DRAG, and the two facts that made it a verb that answered "done" and
   * did nothing. Both were measured on a real Sortable list — a peer session
   * found the first, and the second showed up the moment the fix was run
   * against a tab nobody was looking at.
   */
  test("dragstart leaves from the item being dragged, not from the handle", async () => {
    const el = fakeGuest(() => ({ kind: "ok" }));
    await runBrowserAsk(el, ask("drag", { selector: ".grip", to: "#row-a" }));
    const src = el.ran[0] ?? "";
    // Sortable puts draggable="true" on the ITEM and uses the handle only to
    // decide whether a tap counts, so a dragstart from the handle is never
    // associated with the gesture: choose:true, start:false, and a
    // .sortable-drag left in the page that nothing comes back to clear.
    expect(src).toContain('closest(\'[draggable="true"]\')');
    expect(src).toContain("sortable-chosen");
    expect(src).toContain('fire(item, "dragstart"');
    expect(src).toContain('fire(item, "dragend"');
  });

  test("the gesture waits on a timer, because a background tab has no frames", async () => {
    const el = fakeGuest(() => ({ kind: "ok" }));
    await runBrowserAsk(el, ask("drag", { selector: ".grip", to: "#row-a" }));
    // WITHOUT ITS COMMENTS. The script carries a note explaining why rAF is
    // wrong here, and an assertion that a word is ABSENT trips over the note
    // that names it — which has now cost this repo the same afternoon twice.
    const src = (el.ran[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // requestAnimationFrame never fires on a tab that is not painting, so the
    // whole gesture hung there until the verb timed out — and an agent's tab
    // is almost never the one on screen.
    expect(src, "rAF does not fire on a tab that is not painting").not.toContain("requestAnimationFrame");
    expect(src).toContain("setTimeout");
  });

  test("both still catch the page's throw in the page", async () => {
    for (const args of [{ js: "boom()" }, { js: "boom()", await: true }]) {
      const el = fakeGuest(() => ({ __agxOk: true, __agxV: null }));
      await runBrowserAsk(el, ask("eval", args));
      expect(el.ran[0], "the throw is left to cross the bridge").toContain("__agxErr");
    }
  });
});

describe("cookies --set is backed by the jar it claims", () => {
  /*
   * A REGRESSION THIS FILE DID NOT CATCH, which is the reason it is here.
   *
   * `cookies --set` answered `ok` on the strength of the write script not
   * throwing, never on the jar actually holding the cookie afterwards — and
   * `fakeGuest`'s canned answers can't tell the difference, since they never
   * run the code at all. `fakeGuestWithCookies` does: it is the same path a
   * real page's `document.cookie` is, so a write that does not stick fails
   * this test instead of reporting success.
   */
  test("set, then read back through the same path", async () => {
    const el = fakeGuestWithCookies();
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "session", value: "abc123" } }));
    expect(r).toEqual({ ok: true, value: { cookies: "session=abc123", note: expect.any(String) } });
  });

  test("a cookie for a domain the page isn't on does not land, and the verb says so", async () => {
    const el = fakeGuestWithCookies("example.com");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "a", value: "b", domain: "other.com" } }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("a");  });
});
