/*
 * What each browser verb actually does to a page.
 *
 * Run against a stand-in for the guest, because the interesting failures are
 * about the JavaScript this builds, not about Chromium: a selector pasted into
 * a template instead of being encoded, a click that reports success having hit
 * nothing, and a typed value that a framework throws away on its next render.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";

/** Records the code it is asked to run and answers with whatever was queued. */
function fakeGuest(answer: (code: string) => unknown = () => true) {
  const ran: string[] = [];
  const keys: string[] = [];
  const el: DrivableWebview & { ran: string[]; keys: string[]; back: boolean; forward: boolean } = {
    ran,
    keys,
    back: true,
    forward: false,
    loadURL: async () => {},
    goBack: () => { ran.push("goBack"); },
    goForward: () => { ran.push("goForward"); },
    canGoBack: () => el.back,
    canGoForward: () => el.forward,
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
    expect(el.ran[0]).toContain(String.raw`document.querySelector("a[href=\"x\"]")`);
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
    const r = await runBrowserAsk(el, ask("shot"), async () => "data:image/png;base64,FROMSHELL");
    expect((r.value as any).png).toBe("data:image/png;base64,FROMSHELL");
  });

  test("and the element still answers on a shell that cannot", async () => {
    const r = await runBrowserAsk(fakeGuest(), ask("shot"), async () => null);
    expect((r.value as any).png).toStartWith("data:image/png");
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

  test("a key is a real key event, down and up", async () => {
    // A KeyboardEvent built in JavaScript is untrusted: it moves no caret and
    // submits no form. Half a keystroke is invisible to a page listening on
    // keyup.
    const el = fakeGuest();
    await runBrowserAsk(el, ask("press", { key: "Escape" }));
    expect(el.keys).toEqual(["keyDown:Escape", "keyUp:Escape"]);
  });

  test("an empty capture is a failure, not a zero-byte screenshot", async () => {
    // Measured twice against the real app: a pane hidden behind another view
    // produces no frames, both captures come back blank, and this used to
    // answer ok with `data:image/png;base64,` — the CLI then wrote an empty
    // file and printed its path. An agent reports on a screenshot that is not
    // there.
    const el = fakeGuest();
    el.capturePage = async () => ({ toDataURL: () => "data:image/png;base64," });
    const r = await runBrowserAsk(el, ask("shot"), async () => null);
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
    expect(r.error).toContain("not on screen");
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);

  test("a page that throws is an answer, not a crashed panel", async () => {
    const el = fakeGuest();
    el.executeJavaScript = async () => { throw new Error("Script failed to execute"); };
    const r = await runBrowserAsk(el, ask("read"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Script failed");
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
    const doc = {
      querySelector: (s: string) => { seen.push(s); return null; },
      body: { innerText: "", scrollHeight: 100 },
      title: "",
    };
    const win = { scrollTo: () => {}, scrollBy: () => {}, scrollY: 0, innerHeight: 10 };
    // `wait` polls on a timer; a no-op setTimeout stops it after one look.
    new Function("document", "window", "location", "setTimeout", `return ${code}`)(
      doc, win, { href: "about:blank" }, () => 0,
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
});
