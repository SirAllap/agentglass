/*
 * What each browser verb actually does to a page.
 *
 * Run against a stand-in for the guest, because the interesting failures are
 * about the JavaScript this builds, not about Chromium: a selector pasted into
 * a template instead of being encoded, a click that reports success having hit
 * nothing, and a typed value that a framework throws away on its next render.
 */
import { describe, expect, test } from "bun:test";
import { claimAgentZoom, forgetAgentZoom, reapplyZoom, resetBrowserSettings, resetStableIds, runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { cookieSetParams as buildCookie } from "../src/lib/cookieSet.ts";

/** Records the code it is asked to run and answers with whatever was queued. */
/*
 * The default answer speaks the shape `resolveOne` returns — `{ kind: "ok" }`
 * — not the bare `true` the page used to hand back. A verb that resolves a
 * selector now distinguishes "matched one", "matched none", "matched several"
 * and "that is not a selector", and a stand-in that answers `true` to all four
 * would let a verb pass while reporting the wrong one.
 */
function fakeGuest(answer: (code: string) => unknown = () => ({ kind: "ok" }), url = "https://example.com/app") {
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
    getURL: () => url,
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
  test("a navigation the egress guard refused says why, not just ERR_TUNNEL_CONNECTION_FAILED", async () => {
    /* The guest reports the bare Chromium code; the shell kept the reason. */
    const el = fakeGuest();
    el.addEventListener = (type: string, fn: (e: Event) => void) => {
      if (type === "did-fail-load") queueMicrotask(() => fn(Object.assign(new Event(type), { errorDescription: "ERR_TUNNEL_CONNECTION_FAILED", isMainFrame: true, errorCode: -111 })));
    };
    const asked: Record<string, unknown>[] = [];
    const shell = async (req: Record<string, unknown>) => {
      asked.push(req);
      return { ok: true, value: { armed: true, refusals: [{ at: 1, host: "meta.example", reason: "meta.example resolves to 169.254.169.254, which is link-local (where cloud metadata lives)" }] } };
    };
    const r = await runBrowserAsk(el, ask("open", { url: "https://meta.example/latest/" }), undefined, undefined, undefined, undefined, undefined, shell);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ERR_TUNNEL_CONNECTION_FAILED");
    expect(r.error).toContain("169.254.169.254");
    expect(asked).toEqual([{ egress: { host: "meta.example" } }]);
    // Any other failure is left alone, and the shell is not asked.
    asked.length = 0;
    el.addEventListener = (type: string, fn: (e: Event) => void) => {
      if (type === "did-fail-load") queueMicrotask(() => fn(Object.assign(new Event(type), { errorDescription: "ERR_NAME_NOT_RESOLVED", isMainFrame: true, errorCode: -105 })));
    };
    const plain = await runBrowserAsk(el, ask("open", { url: "https://nx.example/" }), undefined, undefined, undefined, undefined, undefined, shell);
    expect(plain.error).toBe("ERR_NAME_NOT_RESOLVED");
    expect(asked).toEqual([]);
  });

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
    const found = await runBrowserAsk(fakeGuest(() => ({ kind: "ok", text: "Total: 41" })), ask("text", { selector: ".total" }));
    expect((found.value as any).text).toBe("Total: 41");
    const missing = await runBrowserAsk(fakeGuest(() => ({ kind: "none" })), ask("text", { selector: ".total" }));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain(".total");
  });

  test("scroll answers with where it ended up, not just 'done'", async () => {
    const el = fakeGuest(() => ({ kind: "ok", y: 900, atBottom: true }));
    const r = await runBrowserAsk(el, ask("scroll", { to: "bottom" }));
    expect(r.value).toEqual({ y: 900, atBottom: true });
    expect(el.ran[0]).toContain("document.body.scrollHeight");
    // Scrolling by pixels goes through scrollBy, and the number is a number.
    const by = fakeGuest(() => ({ kind: "ok", y: 400, atBottom: false }));
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

  /*
   * The live screencast: Chromium's compositor pushes frames through
   * `Page.screencastFrame` at its own rate, the shell acks each one and keeps
   * a bounded ring, and the verb drains it. Three actions, and the drain is a
   * pseudo-method the shell answers from the ring rather than a CDP call —
   * the same shape `Fetch.agxSetRules` already uses.
   */
  test("screencast starts with bounded frames, drains the shell's ring, and stops", async () => {
    const f = fakeCdp({
      "Page.agxScreencastFrames": { frames: [
        { at: 1, sessionId: 7, data: "/9j/AAA=", metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1.5 } },
        { at: 2, sessionId: 7, data: "/9j/BBB=", metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1.6 } },
      ], dropped: 3 },
    });
    const start = await runBrowserAsk(fakeGuest(), ask("screencast", { action: "start", quality: 40, maxWidth: 640, maxHeight: 480, everyNth: 2 }),
      undefined, undefined, undefined, f.cdp);
    expect(start.ok, JSON.stringify(start)).toBe(true);
    const began = f.sent.find((s) => s.method === "Page.startScreencast")!;
    expect(began.params).toEqual({ format: "jpeg", quality: 40, maxWidth: 640, maxHeight: 480, everyNthFrame: 2 });

    const frames = await runBrowserAsk(fakeGuest(), ask("screencast", { action: "frames" }), undefined, undefined, undefined, f.cdp);
    expect(frames.ok).toBe(true);
    const v = frames.value as { frames: { at: number; jpeg: string; width: number; height: number; timestamp: number }[]; dropped: number; count: number };
    expect(v.count).toBe(2);
    expect(v.dropped).toBe(3);
    expect(v.frames[1]).toEqual({ at: 2, jpeg: "data:image/jpeg;base64,/9j/BBB=", width: 800, height: 600, timestamp: 1.6 });

    const stop = await runBrowserAsk(fakeGuest(), ask("screencast", { action: "stop" }), undefined, undefined, undefined, f.cdp);
    expect(stop.ok).toBe(true);
    expect(f.sent.map((s) => s.method)).toContain("Page.stopScreencast");
  });

  test("a screencast with no shell behind it says so instead of answering frames", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("screencast", { action: "frames" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("DevTools protocol");
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

/**
 * A stand-in DevTools cookie jar, with Chromium's own prefix rules:
 * `__Host-` needs `secure`, path `"/"`, no `domain`; `__Secure-` needs
 * `secure`; a `domain` that does not match the page's own host is
 * refused. `Network.setCookie` answers `{ success: false }` rather than
 * throwing on any of these — the same shape a real DevTools session
 * returns — and `Network.getCookies` reads back whatever actually landed.
 *
 * Also stands in for the READ half: `document.cookie` genuinely does carry a
 * cookie's value once `Network.setCookie` has landed it, for anything that
 * isn't `httpOnly` — the two do not read from separate worlds — so `el`'s
 * `executeJavaScript` reflects this SAME jar instead of a canned "".
 */
function fakeCookieJar(url: string) {
  const jar: Array<Record<string, unknown>> = [];
  const cdp = async (method: string, params?: unknown) => {
    if (method === "Network.setCookie") {
      const p = { ...(params as Record<string, unknown>) };
      const name = String(p.name);
      const cookieUrl = new URL(String(p.url));
      const rejected =
        (name.startsWith("__Host-") && (p.secure !== true || p.domain || p.path !== "/")) ||
        (name.startsWith("__Secure-") && p.secure !== true) ||
        (typeof p.domain === "string" && p.domain !== "" &&
          cookieUrl.hostname !== p.domain && !cookieUrl.hostname.endsWith(`.${p.domain}`));
      if (rejected) return { ok: true, result: { success: false } };
      jar.push(p);
      return { ok: true, result: { success: true } };
    }
    if (method === "Network.getCookies") {
      return { ok: true, result: { cookies: jar.slice() } };
    }
    return { ok: false, error: `unhandled CDP method in test: ${method}` };
  };
  const el = fakeGuest(() => ({
    cookies: jar.filter((c) => !c.httpOnly).map((c) => `${c.name}=${c.value}`).join("; "),
    note: "httpOnly cookies are not visible to the page and so not here",
  }), url);
  return { el, cdp };
}

/** `cookies` reads through `document.cookie`, unaffected by a set that now
 *  goes through the network stack — this stands in for that read step only,
 *  for the error-path tests that never get as far as a landed cookie. */
function fakeGuestForCookies(url: string) {
  return fakeGuest(() => ({ cookies: "", note: "httpOnly cookies are not visible to the page and so not here" }), url);
}

describe("cookies --set is backed by the jar it claims", () => {
  /*
   * A REGRESSION THIS FILE DID NOT CATCH, which is the reason it is here.
   *
   * `cookies --set` answered `ok` on the strength of a `document.cookie`
   * write not throwing, never on the jar it actually lands in — and Chromium
   * drops any `__Host-`/`__Secure-` cookie written that way regardless,
   * silently, flags and all. The write now goes through
   * `Network.setCookie`/`Network.getCookies`, and `fakeCookieJar` is the
   * same path a real DevTools session is: a write that does not stick, or a
   * prefix rule that is broken, fails these tests instead of reporting
   * success.
   */
  test("a __Host- cookie lands with secure, path \"/\", no domain — FAILS on a document.cookie write", async () => {
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "__Host-orbit_session", value: "abc123" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    expect((r as { value: { set: Record<string, unknown> } }).value.set).toEqual({
      name: "__Host-orbit_session", domain: undefined, path: "/", secure: true, httpOnly: false, sameSite: undefined,
    });
  });

  test("a plain cookie on an https page lands secure", async () => {
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "pref", value: "dark" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    expect((r as { value: { set: Record<string, unknown> } }).value.set.secure).toBe(true);
  });

  test("--http-only lands httpOnly:true, and stays out of the document.cookie echo", async () => {
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "sid", value: "s3cr3t", httpOnly: true } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    const value = (r as { value: { set: Record<string, unknown>; cookies: string } }).value;
    expect(value.set.httpOnly).toBe(true);
    // httpOnly is invisible to the page — this is the fake proving it, not just claiming it.
    expect(value.cookies).not.toContain("s3cr3t");
  });

  test("sameSite is passed through, case-insensitive", async () => {
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "pref", value: "dark", sameSite: "lax" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    expect((r as { value: { set: Record<string, unknown> } }).value.set.sameSite).toBe("Lax");
  });

  test("a __Host- cookie with a domain is refused before it ever reaches CDP", async () => {
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "__Host-x", value: "b", domain: "orbit.example" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("__Host-");
  });

  test("a __Host- cookie on an http page is refused", async () => {
    const { el, cdp } = fakeCookieJar("http://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "__Host-x", value: "b" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("https");
  });

  test("a page that is not on http(s) (about:blank) is refused", async () => {
    const { el, cdp } = fakeCookieJar("about:blank");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "pref", value: "dark" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("open a page");
  });

  test("the value is never repeated back in the `set` metadata", async () => {
    // document.cookie legitimately carries the value for a non-httpOnly
    // cookie (see the httpOnly test above) — this test is scoped to the
    // metadata object, which is the one place a value must never reappear.
    const { el, cdp } = fakeCookieJar("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "pref", value: "top-secret" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    const value = (r as { value: { set: Record<string, unknown> } }).value;
    expect(JSON.stringify(value.set)).not.toContain("top-secret");
  });

  test("a domain other than the page's is refused by Chromium (success:false), worded as its own kind of failure", async () => {
    const { el, cdp } = fakeCookieJar("https://example.com/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "a", value: "b", domain: "other.com" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    // Not "needs the DevTools relay" — the relay answered fine, Chromium refused the cookie.
    expect((r as { error: string }).error).toBe(`Chromium refused cookie "a" — check the prefix rules (__Host-/__Secure-) and the domain`);
  });

  test("not in the jar after the write is still ok:false", async () => {
    // A relay that claims success but the cookie never actually lands
    // (a third-party cookie policy, say) — the getCookies check catches it.
    const el = fakeGuestForCookies("https://orbit.example/");
    const cdp = async (method: string) => {
      if (method === "Network.setCookie") return { ok: true, result: { success: true } };
      if (method === "Network.getCookies") return { ok: true, result: { cookies: [] } };
      return { ok: false, error: "unhandled" };
    };
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "session", value: "abc123" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("not in the page's jar");
  });

  test("no DevTools relay is an honest error, not a silent no-op", async () => {
    const el = fakeGuestForCookies("https://orbit.example/");
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "session", value: "abc123" } }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("DevTools relay");
    expect((r as { error: string }).error).not.toContain("close the inspector");
  });

  test("a relay refused because DevTools is already attached says so, and to retry after closing it — no document.cookie fallback", async () => {
    // M2: the old document.cookie write is the very thing this fix routes
    // around (it drops flags silently), so it is not a fallback here either.
    // The failure is new where the inspector is open on the tab, and the
    // error has to say what changed rather than repeat the generic relay line.
    const el = fakeGuestForCookies("https://orbit.example/");
    const cdp = async () => ({ ok: false, error: "the inspector is attached to this page" });
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "session", value: "abc123" } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("the inspector is attached to this page");
    expect((r as { error: string }).error).toContain("close the inspector and retry");
    // Never wrote through document.cookie as a fallback.
    expect(el.ran.join(" ")).not.toContain("document.cookie =");
  });

  test("the read path is unchanged: a --set through CDP does not touch the document.cookie jar this read uses", async () => {
    const el = fakeGuestWithCookies();
    const setResult = await runBrowserAsk(el, ask("cookies", { set: { name: "session", value: "abc123" } }),
      undefined, undefined, undefined, fakeCookieJar("https://example.com/app").cdp);
    // The SET call's own read-back used el's real document.cookie jar too —
    // untouched by the separate cdp jar it wrote to — so it is still empty.
    expect(setResult).toEqual({ ok: true, value: { cookies: "", note: expect.any(String), set: expect.any(Object) } });
    const r = await runBrowserAsk(el, ask("cookies"));
    expect(r).toEqual({ ok: true, value: { cookies: "", note: expect.any(String) } });
  });
});

describe("cookieSetParams", () => {
  // The old shape of this suite, kept: flags are normalised to booleans so the
  // cases read as "secure or not" rather than "present or absent".
  const cookieSetParams = (url: string, set: Record<string, unknown>) => {
    const r = buildCookie(set, url);
    if ("error" in r) return { ok: false as const, error: r.error };
    return { ok: true as const, params: { ...r.params, secure: !!r.params.secure, httpOnly: !!r.params.httpOnly } };
  };
  test("a plain cookie on https defaults to secure", () => {
    const r = cookieSetParams("https://orbit.example/app", { name: "pref", value: "dark" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params).toMatchObject({ name: "pref", value: "dark", url: "https://orbit.example/", path: "/", secure: true, httpOnly: false });
    }
  });

  test("a plain cookie on http defaults to not secure", () => {
    const r = cookieSetParams("http://orbit.example/app", { name: "pref", value: "dark" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.secure).toBe(false);
  });

  test("explicit secure:false is honoured for a non-prefixed name", () => {
    const r = cookieSetParams("https://orbit.example/app", { name: "pref", value: "dark", secure: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.secure).toBe(false);
  });

  test("__Host- forces secure, path \"/\", and refuses a domain", () => {
    const ok = cookieSetParams("https://orbit.example/", { name: "__Host-s", value: "v" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params).toMatchObject({ secure: true, path: "/" });

    const withPath = cookieSetParams("https://orbit.example/", { name: "__Host-s", value: "v", path: "/app" });
    expect(withPath.ok).toBe(false);

    const withDomain = cookieSetParams("https://orbit.example/", { name: "__Host-s", value: "v", domain: "orbit.example" });
    expect(withDomain.ok).toBe(false);

    const onHttp = cookieSetParams("http://orbit.example/", { name: "__Host-s", value: "v" });
    expect(onHttp.ok).toBe(false);
  });

  test("__Secure- forces secure and requires https", () => {
    const ok = cookieSetParams("https://orbit.example/", { name: "__Secure-s", value: "v" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params.secure).toBe(true);

    const onHttp = cookieSetParams("http://orbit.example/", { name: "__Secure-s", value: "v" });
    expect(onHttp.ok).toBe(false);
  });

  test("sameSite normalises case and requires secure for None", () => {
    const lax = cookieSetParams("https://orbit.example/", { name: "pref", value: "v", sameSite: "STRICT" });
    expect(lax.ok).toBe(true);
    if (lax.ok) expect(lax.params.sameSite).toBe("Strict");

    const badNone = cookieSetParams("https://orbit.example/", { name: "pref", value: "v", sameSite: "none", secure: false });
    expect(badNone.ok).toBe(false);

    const goodNone = cookieSetParams("https://orbit.example/", { name: "pref", value: "v", sameSite: "none" });
    expect(goodNone.ok).toBe(true);

    const bad = cookieSetParams("https://orbit.example/", { name: "pref", value: "v", sameSite: "whenever" });
    expect(bad.ok).toBe(false);
  });

  test("a non-http(s) page is refused", () => {
    const r = cookieSetParams("about:blank", { name: "pref", value: "v" });
    expect(r.ok).toBe(false);
  });

  test("localhost, 127.0.0.1 and [::1] are secure contexts over plain http, same as Chromium treats them", () => {
    for (const origin of ["http://localhost:5173", "http://sub.localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      const plain = cookieSetParams(`${origin}/app`, { name: "pref", value: "v" });
      expect(plain.ok, `${origin} should be ok`).toBe(true);
      if (plain.ok) expect(plain.params.secure, `${origin} should default secure`).toBe(true);

      const host = cookieSetParams(`${origin}/`, { name: "__Host-s", value: "v" });
      expect(host.ok, `${origin} should allow __Host-`).toBe(true);

      const secure = cookieSetParams(`${origin}/`, { name: "__Secure-s", value: "v" });
      expect(secure.ok, `${origin} should allow __Secure-`).toBe(true);
    }
  });

  test("a non-loopback http host is still not a secure context", () => {
    const r = cookieSetParams("http://orbit.example/", { name: "pref", value: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.secure).toBe(false);
  });
});

/*
 * The structured readers: markdown, extract, links, count, search.
 *
 * A tiny DOM, not a real page — the point is that the snippet this builds is
 * run for real, through `new Function`, against something that behaves like a
 * page (querySelector, innerText, childNodes), so the code is tested where it
 * runs, not as a string. A stand-in that never evaluates the snippet was
 * already the failure mode these five verbs are here to close.
 */
describe("structured readers", () => {
  type TN = { nodeType: number; tagName?: string; childNodes: TN[]; textContent: string; innerText: string; hidden?: boolean; getAttribute(n: string): string | null; attributes?: Record<string, string> };

  function text(s: string): TN {
    return { nodeType: 3, textContent: s, innerText: s, childNodes: [], getAttribute: () => null, attributes: {} };
  }

  function el(tag: string, children: TN[] = [], attrs: Record<string, string> = {}): TN {
    const n: TN = {
      nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
      textContent: "", innerText: "", hidden: false, attributes: attrs,
      getAttribute: (name: string) => (attrs[name] ?? null),
    };
    n.innerText = children.map((c) => (c.nodeType === 3 ? c.textContent : c.innerText)).join(" ");
    n.textContent = n.innerText;
    return n;
  }

  function buildDoc() {
    const pricingLink = el("a", [text("price list")], { href: "/pricing" });
    const dupLink = el("a", [text("price list")], { href: "/pricing" });
    const jsLink = el("a", [text("careful")], { href: "javascript:alert(1)" });
    const hashLink = el("a", [text("top")], { href: "#top" });
    const priceEl = el("div", [text("$12")], { class: "price" });
    const body = el("body", [
      el("h1", [text("Prices")]),
      el("p", [text("See the "), pricingLink, text(" for details")]),
      el("ul", [el("li", [text("Alpha")]), el("li", [text("Beta")])]),
      dupLink, jsLink, hashLink,
      el("button", [text("Buy now")]),
      el("input", [], { type: "text" }),
      priceEl,
    ]);
    const parts = (s: string) => s.split(",").map((p) => p.trim());
    const doc = {
      body, title: "Demo", documentElement: body,
      querySelector: (s: string) => doc.querySelectorAll(s)[0] ?? null,
      querySelectorAll(s: string): TN[] {
        const ps = parts(s);
        const match = (n: TN) => ps.some((p) => {
          if (!p) return false;
          if (p.startsWith("[")) return !!(n.attributes || {})[p.slice(1, -1)];
          if (p.startsWith("#")) return (n.attributes || {}).id === p.slice(1);
          if (p.startsWith(".")) return ((n.attributes || {}).class || "").split(/\s+/).includes(p.slice(1));
          const parsed = /^([a-z0-9]*)(\[([a-zA-Z0-9_-]+)\])?$/.exec(p)!;
          const tag = parsed[1]!, attr = parsed[3];
          if (attr && !(n.attributes || {})[attr]) return false;
          return tag ? (n.tagName || "").toLowerCase() === tag : true;
        });
        const out: TN[] = [];
        const walk = (n: TN) => { if (match(n)) out.push(n); n.childNodes.forEach(walk); };
        walk(body);
        return out;
      },
    } as const;
    return { doc };
  }

  function run(code: string, page: { doc: { body: TN; querySelector: (s: string) => TN | null; querySelectorAll: (s: string) => TN[] } }) {
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
    return new Function("document", "window", "location", "getComputedStyle", `return ${code}`)(
      page.doc, win, { href: "https://example.com/app" }, win.getComputedStyle,
    );
  }

  test("markdown turns headings, links and lists into readable markdown", async () => {
    const page = buildDoc();
    const el0 = fakeGuest((code) => run(code, page));
    const r = await runBrowserAsk(el0, ask("markdown"));
    expect(r.ok).toBe(true);
    const md = (r as { value: { markdown: string } }).value.markdown;
    expect(md).toContain("# Prices");
    expect(md).toContain("[price list](/pricing)");
    expect(md).toContain("- Alpha");
    expect(md).toContain("- Beta");
    expect(el0.ran[0]).toContain(".slice(0, 20000)");
  });

  test("extract pulls named fields by selector and names the nulls", async () => {
    const page = buildDoc();
    const el0 = fakeGuest((code) => run(code, page));
    const r = await runBrowserAsk(el0, ask("extract", { fields: { title: "h1", price: ".price", nope: ".nope" } }));
    expect(r.ok).toBe(true);
    const v = (r as { value: { fields: Record<string, string | null>; notFound: string[] } }).value;
    expect(v.fields.title).toBe("Prices");
    expect(v.fields.price).toBe("$12");
    expect(v.fields.nope).toBeNull();
    expect(v.notFound).toEqual(["nope"]);
  });

  test("links returns every link, deduplicates, and keeps the real total", async () => {
    const page = buildDoc();
    const el0 = fakeGuest((code) => run(code, page));
    const r = await runBrowserAsk(el0, ask("links"));
    expect(r.ok).toBe(true);
    const v = (r as { value: { total: number; links: { text: string; href: string }[]; dropped: number } }).value;
    expect(v.total).toBe(2);
    expect(v.links).toEqual([{ text: "price list", href: "/pricing" }]);
    expect(v.dropped).toBe(1);
  });

  test("count with a selector gives the match count, without it counts interactive elements", async () => {
    const page = buildDoc();
    const el0 = fakeGuest((code) => run(code, page));
    const r1 = await runBrowserAsk(el0, ask("count", { selector: ".price" }));
    expect((r1 as { value: { count: number } }).value.count).toBe(1);
    const r2 = await runBrowserAsk(el0, ask("count", {}));
    expect((r2 as { value: { count: number; scope: string } }).value.scope).toBe("interactive");
    expect((r2 as { value: { count: number } }).value.count).toBeGreaterThanOrEqual(3);
  });

  test("search finds the right elements and brings back their hrefs", async () => {
    const page = buildDoc();
    const el0 = fakeGuest((code) => run(code, page));
    const r = await runBrowserAsk(el0, ask("search", { query: "price" }));
    expect(r.ok).toBe(true);
    const v = (r as { value: { count: number; matches: { text: string; href: string }[] } }).value;
    expect(v.count).toBeGreaterThanOrEqual(2);
    expect(v.matches.some((m) => m.href === "/pricing")).toBe(true);
  });
});

/*
 * The snapshot → element-ref loop, under the three things that go wrong with
 * it: the page navigated and the id names a document that is gone; the id was
 * handed out by an observe of another tab; the node was removed or re-rendered
 * since the observe. Each used to answer "nothing on the page matches e17" —
 * or worse, act on whatever the new page happened to stamp as e17 — and none
 * of them told the agent the one thing it needed to hear, which is "observe
 * again". Run for real through `new Function` against a page-shaped stand-in,
 * because the fate of an id is decided inside the page.
 */
describe("stale ids say why, and say to observe again", () => {
  type Node = {
    tagName: string; dataset: Record<string, string>; innerText: string; id: string; className: string;
    disabled: boolean; parentElement: null; outerHTML: string; textContent: string;
    getAttribute(n: string): string | null; getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number };
    contains(o: unknown): boolean; scrollIntoView(): void; click(): void; querySelectorAll(sel: string): Node[];
  };

  /** A document with one button per label, a window of its own (so `__agxSeq`
   *  lives where a real page keeps it), and the guest that runs scripts
   *  against them. */
  function fakePage(buttons: string[], href = "https://example.com/a") {
    const clicked: string[] = [];
    const nodes: Node[] = buttons.map((label, i) => ({
      tagName: "BUTTON", dataset: {}, innerText: label, id: "", className: "", disabled: false, parentElement: null,
      outerHTML: `<button>${label}</button>`, textContent: label,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 10, y: 10 + 40 * i, width: 80, height: 20, top: 10 + 40 * i, left: 10 }),
      contains: () => false,
      scrollIntoView() {},
      click() { clicked.push(label); },
      querySelectorAll: () => [],
    }));
    /* The form the buttons sit in — what `region` is pointed at. */
    const form: Node = {
      ...nodes[0]!, tagName: "FORM", innerText: buttons.join(" "), textContent: buttons.join(" "), dataset: {},
      outerHTML: "<form>…</form>", click() {},
      querySelectorAll: (sel: string) => (sel.startsWith("a,button") ? nodes : []),
    };
    const win: Record<string, unknown> = {};
    const document = {
      title: "A page", visibilityState: "visible", readyState: "complete", cookie: "",
      hasFocus: () => true,
      elementFromPoint: (_x: number, y: number) => nodes.find((n) => { const r = n.getBoundingClientRect(); return y >= r.top && y <= r.top + r.height; }) ?? null,
      querySelectorAll(sel: string): Node[] {
        const m = /^\[data-agx-e="(e\d+)"\]$/.exec(sel);
        if (m) return [form, ...nodes].filter((n) => n.dataset.agxE === m[1]);
        if (sel.startsWith("a,button")) return nodes;
        if (sel === "form") return [form];
        return [];
      },
      querySelector(sel: string): Node | null { return document.querySelectorAll(sel)[0] ?? null; },
    };
    const run = (code: string) => new Function(
      "window", "document", "location", "getComputedStyle", "innerWidth", "innerHeight", "localStorage", "sessionStorage",
      `return ${code}`,
    )(win, document, { href }, () => ({ display: "block", visibility: "visible", opacity: "1" }), 1200, 800, {}, {});
    /* The collector patches fetch and friends on a real window; here it has
       nothing to patch and nothing this checks depends on it. */
    const el = fakeGuest((code) => (code.includes("__agxLog = log") ? 1 : run(code)));
    return { el, win, nodes, clicked };
  }

  const ids = (r: { value?: unknown }) => ((r.value as { tree: { e: string }[] }).tree.map((t) => t.e));

  test("an id used on a page that has not been observed since it loaded is refused", async () => {
    resetStableIds();
    const page = fakePage(["Save"]);
    const r = await runBrowserAsk(page.el, ask("click", { selector: "e17" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("e17");
    expect(r.error, "the fix is to observe again, and it must say so").toMatch(/observe/i);
    expect(r.error, "and where the tab is now, since the id came from somewhere else").toContain("https://example.com/a");
    expect(page.clicked).toEqual([]);
  });

  test("two documents never share an id, so an id from the other tab is refused rather than acted on", async () => {
    resetStableIds();
    const a = fakePage(["Delete account", "Cancel"], "https://example.com/a");
    const b = fakePage(["Confirm purchase", "Back"], "https://example.com/b");
    const seenA = ids(await runBrowserAsk(a.el, ask("observe", {})));
    const seenB = ids(await runBrowserAsk(b.el, ask("observe", {})));
    expect(seenA).toEqual(["e1", "e2"]);
    // The second page carries on where the first stopped: e1 means one thing.
    expect(seenB.some((e) => seenA.includes(e))).toBe(false);
    // The id of "Delete account", sent to the tab holding "Confirm purchase".
    const r = await runBrowserAsk(b.el, ask("click", { selector: "e1" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("e1 ");
    expect(r.error).toMatch(/another tab|a page this tab has left/);
    expect(r.error).toMatch(/observe/i);
    expect(b.clicked, "nothing on the other page was touched").toEqual([]);
    // And on its own page it still works.
    const ok = await runBrowserAsk(a.el, ask("click", { selector: "e1" }));
    expect(ok.ok).toBe(true);
    expect(a.clicked).toEqual(["Delete account"]);
  });

  test("an id whose node was removed since the observe says so, not \"nothing matches\"", async () => {
    resetStableIds();
    const page = fakePage(["Save", "Discard"]);
    const seen = ids(await runBrowserAsk(page.el, ask("observe", {})));
    expect(seen).toEqual(["e1", "e2"]);
    page.nodes.splice(1, 1); // a re-render drops "Discard"
    const r = await runBrowserAsk(page.el, ask("click", { selector: "e2" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/removed or re-rendered/);
    expect(r.error).toMatch(/observe again/i);
    expect(r.error).not.toContain("nothing on the page matches");
  });

  test("the same page observed twice keeps its ids and numbers new nodes after them", async () => {
    resetStableIds();
    const page = fakePage(["Save"]);
    expect(ids(await runBrowserAsk(page.el, ask("observe", {})))).toEqual(["e1"]);
    page.nodes.push({ ...page.nodes[0]!, dataset: {}, innerText: "Undo" });
    // Dense: a second observe does not skip ahead when nobody else took ids in between.
    expect(ids(await runBrowserAsk(page.el, ask("observe", {})))).toEqual(["e1", "e2"]);
  });

  test("two observations in flight at once take disjoint ids", async () => {
    resetStableIds();
    const a = fakePage(["One", "Two"]);
    const b = fakePage(["Three"]);
    /* Both scripts are built before either answers — the shape of two agents
       on two tabs, and of `do` lanes. The reservation is what keeps the
       second from starting where the first started. */
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseA = r; });
    const runA = a.el.executeJavaScript;
    a.el.executeJavaScript = async (code: string) => { await gate; return runA(code); };
    const pa = runBrowserAsk(a.el, ask("observe", {}));
    const pb = runBrowserAsk(b.el, ask("observe", {}));
    releaseA();
    const [ra, rb] = await Promise.all([pa, pb]);
    const seenA = ids(ra), seenB = ids(rb);
    expect(seenA.length).toBe(2);
    expect(seenB.length).toBe(1);
    expect(seenA.some((e) => seenB.includes(e))).toBe(false);
  });

  test("wait on an id the page never handed out fails at once instead of polling for 30 s", async () => {
    resetStableIds();
    const page = fakePage(["Save"]);
    const started = Date.now();
    const r = await runBrowserAsk(page.el, ask("wait", { selector: "e9" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/observe/i);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.el.ran.some((c) => c.includes("setTimeout(tick, 120)")), "no polling loop was started for an id").toBe(false);
  });

  test("every verb that takes a selector takes an id — html and text included", async () => {
    resetStableIds();
    const page = fakePage(["Save"]);
    await runBrowserAsk(page.el, ask("observe", {}));
    const h = await runBrowserAsk(page.el, ask("html", { selector: "e1" }));
    expect(h.ok, JSON.stringify(h)).toBe(true);
    expect((h.value as { html: string }).html).toContain("Save");
    const t = await runBrowserAsk(page.el, ask("text", { selector: "e1" }));
    expect(t.ok, JSON.stringify(t)).toBe(true);
    // And a miss on one of these explains itself the same way click does.
    const miss = await runBrowserAsk(page.el, ask("html", { selector: "e40" }));
    expect(miss.ok).toBe(false);
    expect(miss.error).toMatch(/observe/i);
  });

  test("region mints its ids from the same counter, so the next click accepts them", async () => {
    resetStableIds();
    const other = fakePage(["Elsewhere"]);
    await runBrowserAsk(other.el, ask("observe", {}));
    const page = fakePage(["Save", "Discard"]);
    const r = await runBrowserAsk(page.el, ask("region", { selector: "form" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const v = r.value as { e: string; tree: { e: string }[]; idSeq?: number };
    expect(v.idSeq, "the counter stays off the wire here too").toBeUndefined();
    // Counted on from the other page, never from one.
    expect(v.tree.map((t) => t.e)).not.toContain("e1");
    const click = await runBrowserAsk(page.el, ask("click", { selector: v.tree[1]!.e }));
    expect(click.ok, JSON.stringify(click)).toBe(true);
    expect(page.clicked).toEqual(["Discard"]);
  });

  test("an observation does not leak its counter into the answer", async () => {
    resetStableIds();
    const page = fakePage(["Save"]);
    const r = await runBrowserAsk(page.el, ask("observe", {}));
    expect(r.ok).toBe(true);
    /* The id counter, not `seq`: that one numbers observations for observe --delta and is meant for the caller. */
    expect((r.value as Record<string, unknown>).idSeq).toBeUndefined();
  });
});

/*
 * The interactive inventory: `interactive`, `forms` and `attr`. Run for real
 * through `new Function` against a page-shaped stand-in with a form in it, so
 * the shape an agent gets is the shape the code produces, not the shape a
 * stub was told to return. Ids come from the same counter as `observe`, so
 * the next click accepts them — that is what makes an inventory usable.
 */
describe("the interactive inventory", () => {
  type N = {
    tagName: string; attributes: Record<string, string>; children: N[]; dataset: Record<string, string>;
    innerText: string; textContent: string; id: string; name: string; type: string; value: string;
    checked: boolean; disabled: boolean; required: boolean; placeholder: string; href: string; action: string; method: string;
    form: N | null; labels: { innerText: string }[]; options: { value: string; text: string }[]; parentElement: N | null;
    getAttribute(n: string): string | null; getAttributeNames(): string[]; getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number };
    querySelectorAll(sel: string): N[]; contains(o: unknown): boolean; scrollIntoView(): void; click(): void;
  };
  function node(tag: string, attrs: Record<string, string> = {}, children: N[] = [], text = ""): N {
    const n: N = {
      tagName: tag.toUpperCase(), attributes: attrs, children, dataset: {},
      innerText: text || children.map((c) => c.innerText).join(" "), textContent: text, id: attrs.id ?? "", name: attrs.name ?? "",
      type: attrs.type ?? (tag === "input" ? "text" : tag === "button" ? "submit" : ""), value: attrs.value ?? "",
      checked: "checked" in attrs, disabled: "disabled" in attrs, required: "required" in attrs, placeholder: attrs.placeholder ?? "",
      href: attrs.href ? `https://example.com${attrs.href}` : "", action: attrs.action ? `https://example.com${attrs.action}` : "", method: attrs.method ?? "get",
      form: null, labels: attrs["aria-labelledby"] ? [{ innerText: attrs["aria-labelledby"] }] : [], options: [], parentElement: null,
      // HTML attribute names are case-insensitive, and getAttribute folds them.
      getAttribute: (k) => (k.toLowerCase() in attrs ? attrs[k.toLowerCase()]! : null), getAttributeNames: () => Object.keys(attrs),
      getBoundingClientRect: () => (attrs.hidden !== undefined ? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 } : { x: 10, y: 10, width: 100, height: 20, top: 10, left: 10 }),
      querySelectorAll: (sel) => query(n, sel, false),
      contains: () => false, scrollIntoView() {}, click() {},
    };
    for (const c of children) c.parentElement = n;
    return n;
  }
  /** Comma-separated simple selectors: tag, [attr], [attr=val], #id, chained. */
  function matches(n: N, simple: string): boolean {
    const m = /^([a-z0-9]*)((?:#[\w-]+|\[[^\]]+\])*)$/.exec(simple.trim());
    if (!m) return false;
    if (m[1] && n.tagName.toLowerCase() !== m[1]) return false;
    for (const part of m[2]!.match(/#[\w-]+|\[[^\]]+\]/g) ?? []) {
      if (part.startsWith("#")) { if (n.id !== part.slice(1)) return false; continue; }
      const [k, v] = part.slice(1, -1).split("=");
      const val = v?.replace(/^['"]|['"]$/g, "");
      if (k === "data-agx-e") { if (n.dataset.agxE !== val) return false; continue; }
      if (!(k! in n.attributes)) return false;
      if (v !== undefined && n.attributes[k!] !== val) return false;
    }
    return true;
  }
  function query(root: N, sel: string, self: boolean): N[] {
    const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
    const out: N[] = [];
    const walk = (n: N, top: boolean) => { if ((!top || self) && parts.some((p) => matches(n, p))) out.push(n); n.children.forEach((c) => walk(c, false)); };
    walk(root, true);
    return out;
  }
  function buildPage() {
    const user = node("input", { name: "user", type: "text", placeholder: "you@example.com", required: "", "aria-labelledby": "Email" });
    const pw = node("input", { name: "pw", type: "password", value: "hunter2" });
    const remember = node("input", { name: "remember", type: "checkbox", checked: "" });
    const plan = node("select", { name: "plan" });
    plan.options = [{ value: "free", text: "Free" }, { value: "pro", text: "Pro" }];
    plan.value = "pro";
    const token = node("input", { name: "csrf", type: "hidden", value: "abc" });
    const go = node("button", { type: "submit" }, [], "Sign in");
    const form = node("form", { id: "login", action: "/session", method: "post" }, [user, pw, remember, plan, token, go]);
    for (const f of [user, pw, remember, plan, token, go]) f.form = form;
    const search = node("input", { name: "q", type: "search", placeholder: "Search" });
    /* Whitespace inside a name, and an `s` in it: the collapse is `\s+` on
       the page, and a `\s` typed once in a template literal reaches the page
       as a bare `s` — which would eat the letter and keep the newline. */
    const link = node("a", { href: "/pricing", "data-testid": "pricing" }, [], "See  prices\n  now");
    const dead = node("button", { disabled: "" }, [], "Nope");
    const ghost = node("button", { hidden: "" }, [], "Ghost");
    const body = node("body", {}, [node("h1", {}, [], "Sign in"), form, search, link, dead, ghost]);
    const win: Record<string, unknown> = {};
    const document = {
      title: "Sign in", body, querySelectorAll: (sel: string) => query(body, sel, true), querySelector: (sel: string) => query(body, sel, true)[0] ?? null,
      elementFromPoint: () => null,
    };
    const run = (code: string) => new Function("window", "document", "location", "getComputedStyle", "innerWidth", "innerHeight", `return ${code}`)(
      win, document, { href: "https://example.com/login" }, (n: N) => ({ display: n.attributes.hidden !== undefined ? "none" : "block", visibility: "visible", opacity: "1" }), 1200, 800);
    const el = fakeGuest((code) => (code.includes("__agxLog = log") ? 1 : run(code)));
    return { el, win, nodes: { user, pw, remember, plan, token, go, form, search, link, dead, ghost } };
  }

  test("interactive lists what can be acted on, with what an agent needs to act: href, value, checked, options", async () => {
    resetStableIds();
    const page = buildPage();
    const r = await runBrowserAsk(page.el, ask("interactive", {}));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const v = r.value as { total: number; hidden: number; elements: Record<string, unknown>[]; idSeq?: number };
    expect(v.idSeq).toBeUndefined();
    const by = (name: string) => v.elements.find((e) => e.name === name);
    expect(by("See prices now")).toMatchObject({ role: "link", href: "https://example.com/pricing", testid: "pricing" });
    expect(by("Email")).toMatchObject({ role: "text", placeholder: "you@example.com" });
    expect(by("pw")?.value ?? v.elements.find((e) => e.role === "password")?.value, "a password never travels").toBe("(hidden)");
    expect(v.elements.find((e) => e.role === "checkbox")).toMatchObject({ checked: true });
    expect(v.elements.find((e) => e.role === "select")).toMatchObject({ value: "pro", options: ["free", "pro"] });
    expect(by("Nope")).toMatchObject({ disabled: true });
    expect(v.elements.some((e) => e.role === "hidden"), "a hidden input is not something to act on").toBe(false);
    expect(by("Ghost"), "an invisible button is counted, not listed").toBeUndefined();
    expect(v.hidden).toBe(1);
    expect(v.elements.every((e) => /^e\d+$/.test(String(e.e)))).toBe(true);
  });

  test("its ids are minted from the same counter as observe, so a click accepts them", async () => {
    resetStableIds();
    const other = buildPage();
    await runBrowserAsk(other.el, ask("observe", {}));
    const page = buildPage();
    const r = await runBrowserAsk(page.el, ask("interactive", {}));
    const link = (r.value as { elements: { name: string; e: string }[] }).elements.find((e) => e.name === "See prices now")!;
    expect(link.e).not.toBe("e1");
    const clicked = await runBrowserAsk(page.el, ask("text", { selector: link.e }));
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
  });

  test("forms come back as forms: fields with labels, the submit, and the fields that belong to none", async () => {
    resetStableIds();
    const page = buildPage();
    const r = await runBrowserAsk(page.el, ask("forms", {}));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const v = r.value as { forms: Record<string, unknown>[]; loose: Record<string, unknown>[]; idSeq?: number };
    expect(v.idSeq).toBeUndefined();
    expect(v.forms).toHaveLength(1);
    const f = v.forms[0] as { id: string; action: string; method: string; fields: Record<string, unknown>[]; hiddenFields: number; submit: Record<string, unknown>[] };
    expect(f).toMatchObject({ id: "login", action: "https://example.com/session", method: "post", hiddenFields: 1 });
    expect(f.fields.map((x) => x.name)).toEqual(["user", "pw", "remember", "plan"]);
    expect(f.fields[0]).toMatchObject({ label: "Email", required: true, type: "text" });
    expect(f.fields[1]).toMatchObject({ type: "password", value: "(hidden)" });
    expect(f.fields[3]).toMatchObject({ type: "select", value: "pro", options: ["free", "pro"] });
    expect(f.submit).toHaveLength(1);
    expect(f.submit[0]).toMatchObject({ text: "Sign in" });
    expect(v.loose.map((x) => x.name)).toEqual(["q"]);
    // Every id is an id a verb will take.
    expect(/^e\d+$/.test(String(f.submit[0]!.e))).toBe(true);
    expect(/^e\d+$/.test(String(f.fields[0]!.e))).toBe(true);
  });

  test("attr answers the attributes asked for, null for one that is not there, and all of them when none is named", async () => {
    resetStableIds();
    const page = buildPage();
    const some = await runBrowserAsk(page.el, ask("attr", { selector: "a", names: ["href", "data-testid", "rel"] }));
    expect(some.ok, JSON.stringify(some)).toBe(true);
    expect(some.value).toMatchObject({ tag: "a", attributes: { href: "/pricing", "data-testid": "pricing", rel: null } });
    const all = await runBrowserAsk(page.el, ask("attr", { selector: "#login" }));
    expect(all.ok).toBe(true);
    expect((all.value as { attributes: Record<string, string> }).attributes).toEqual({ id: "login", action: "/session", method: "post" });
    // A password's value attribute is as secret as its value.
    const pw = await runBrowserAsk(page.el, ask("attr", { selector: "input[type=password]", names: ["value", "name"] }));
    expect((pw.value as { attributes: Record<string, unknown> }).attributes).toEqual({ value: "(hidden)", name: "pw" });
    // getAttribute ignores case, so the mask does too: `VALUE` was the way
    // round it.
    const shout = await runBrowserAsk(page.el, ask("attr", { selector: "input[type=password]", names: ["VALUE", "Value"] }));
    expect((shout.value as { attributes: Record<string, unknown> }).attributes).toEqual({ VALUE: "(hidden)", Value: "(hidden)" });
    // Two matches is a refusal with the count, same as click.
    const many = await runBrowserAsk(page.el, ask("attr", { selector: "button", names: ["type"] }));
    expect(many.ok).toBe(false);
    expect(many.error).toContain("matched");
  });
});

describe("cookies --set with attributes goes through the protocol, not document.cookie", () => {
  /*
   * `document.cookie` cannot write an HttpOnly cookie at all, and a `__Host-`
   * one only with `Secure` in the string, which the verb never put there —
   * measured in Chromium, `__Host-x=1; path=/` is dropped without a word. So a
   * copied session could never be finished by hand with this verb. Any
   * attribute, or a prefixed name, takes Network.setCookie instead, and the
   * answer names what landed without echoing the value.
   */
  const jar: Array<Record<string, unknown>> = [];
  const cdp = async (method: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "Network.setCookie") { jar.push(p); return { ok: true, result: { success: true } }; }
    if (method === "Network.getCookies") return { ok: true, result: { cookies: jar.map((c) => ({ name: c.name, value: c.value })) } };
    return { ok: true, result: {} };
  };
  const run = (set: Record<string, unknown>) => {
    jar.length = 0;
    return runBrowserAsk(fakeGuest(), ask("cookies", { set }), undefined, undefined, undefined, cdp);
  };

  test("a __Host- cookie is secure, host-only and at / without being told", async () => {
    const r = await run({ name: "__Host-orbit_sid", value: "s3cr3t-v4lue", httpOnly: true, sameSite: "Lax" });
    expect(r.ok).toBe(true);
    expect(jar[0]).toMatchObject({ name: "__Host-orbit_sid", url: "https://example.com/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    expect(jar[0]).not.toHaveProperty("domain");
    expect(JSON.stringify(r), "the answer echoed the cookie's value").not.toContain("s3cr3t-v4lue");
  });

  test("a __Host- cookie with a domain is refused before it is sent", async () => {
    const r = await run({ name: "__Host-a", value: "b", domain: "example.com" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("__Host-");
    expect(jar).toHaveLength(0);
  });

  test("every attribute is carried: domain, expiry, SameSite=None, a partition", async () => {
    const r = await run({
      name: "theme", value: "dark", domain: ".example.com", secure: true, sameSite: "None",
      expires: 1_900_000_000, partitionKey: "https://orbit.example",
    });
    expect(r.ok).toBe(true);
    expect(jar[0]).toMatchObject({
      domain: ".example.com", url: "https://example.com/", secure: true, sameSite: "None", expires: 1_900_000_000,
      partitionKey: { topLevelSite: "https://orbit.example", hasCrossSiteAncestor: false },
    });
  });

  test("SameSite=None without Secure is refused, since Chromium would drop it", async () => {
    const r = await run({ name: "x", value: "y", sameSite: "None", secure: false });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("Secure");
  });

  test("an imported cookie names its own host, so a host-only one is set while the page is elsewhere", async () => {
    // session import sets cookies before the tab is on the site; a host-only
    // cookie must bind to ITS host, not to about:blank's.
    const el = fakeGuest();
    (el as { getURL: () => string }).getURL = () => "about:blank";
    const r = await runBrowserAsk(el, ask("cookies", { set: { name: "s", value: "v", host: "www.orbit.example", secure: true, httpOnly: true } }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(true);
    expect(jar[0]).toMatchObject({ url: "https://www.orbit.example/", secure: true });
    expect(jar[0]).not.toHaveProperty("domain");
  });

  test("a write the protocol accepts but the jar does not hold is still a failure", async () => {
    const liar = async (method: string) => method === "Network.getCookies"
      ? { ok: true, result: { cookies: [] } } : { ok: true, result: { success: true } };
    const r = await runBrowserAsk(fakeGuest(), ask("cookies", { set: { name: "a", value: "b", httpOnly: true } }),
      undefined, undefined, undefined, liar);
    expect(r.ok).toBe(false);
  });
});
