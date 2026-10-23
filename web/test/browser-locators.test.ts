/*
 * How a verb finds the element it acts on.
 *
 * There is no DOM in these suites, so the scripts the driver builds are run
 * against a small stand-in page: nodes with the handful of properties the
 * scripts read, a document that answers the few selector shapes they ask, a
 * window. The script is the real string handed to executeJavaScript — the
 * thing under test is what it finds, which reading its source cannot pin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runBrowserAsk, setFindWaitMs } from "../src/lib/browserDrive.ts";
import { parseLocator } from "../src/lib/browserLocator.ts";
import { N, h, page } from "./standinDom.ts";

const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

/* The hostile suites plant a canary on the global; every suite shares this process. */
afterAll(() => { delete (globalThis as { __canary?: unknown }).__canary; });

/* An act verb waits for a selector that matches nothing yet. The refusals
   below are about what the sentence says, not about waiting for it. */
beforeAll(() => setFindWaitMs(0));
afterAll(() => setFindWaitMs());

/** The sign-up form every suite below points at. Ids are stamped the way
 *  observe stamps them, so `e2` means what an observation said it meant. */
function signup() {
  const plan = h("select", { id: "plan", "data-agx-e": "e3" });
  plan.options = [{ value: "", text: "Choose…" }, { value: "team", text: "Team" }];
  const body = h("body", {},
    h("form", {},
      h("label", { for: "email" }, "Email"),
      h("input", { id: "email", type: "email", "data-agx-e": "e2" }),
      h("label", { for: "plan" }, "Plan"),
      plan,
      h("button", { type: "submit", "data-agx-e": "e4" }, "Create account"),
    ),
  );
  return { body, plan, ...page(body) };
}

describe("select, which did not take an id from an observation", () => {
  /*
   * Measured on the bench: `select e3` answered "nothing matched" for a
   * <select> the tree had just listed as e3, because this one verb handed the
   * raw string to querySelector without the rewrite every other act verb
   * gets. An agent then falls back to inventing CSS — the anti-feature.
   */
  test("select e3 picks the option on the element observe called e3", async () => {
    const { guest, plan } = signup();
    const r = await runBrowserAsk(guest, ask("select", { selector: "e3", value: "team" }));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(plan.value).toBe("team");
    expect(plan.events).toContain("change");
  });

  test("and still says which options there are when the value is not one", async () => {
    const { guest } = signup();
    const r = await runBrowserAsk(guest, ask("select", { selector: "e3", value: "gold" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no such option");
    expect(r.error).toContain("team");
  });

  test("and refuses a thing that is not a <select> by saying so", async () => {
    const { guest } = signup();
    const r = await runBrowserAsk(guest, ask("select", { selector: "e2", value: "team" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a <select>");
  });
});

/** A DevTools stand-in that evaluates the expression in `run`'s page and
 *  answers the way Runtime.evaluate does: a node is a remote object, a string
 *  is a value. */
function cdpOver(run: (code: string) => Promise<unknown>) {
  const calls: string[] = [];
  const cdp = async (method: string, params?: unknown) => {
    calls.push(method);
    if (method === "Runtime.evaluate") {
      const v = await run((params as { expression: string }).expression);
      return typeof v === "string"
        ? { ok: true, result: { result: { type: "string", value: v } } }
        : { ok: true, result: { result: { type: "object", subtype: "node", objectId: "obj-1" } } };
    }
    if (method === "DOM.requestNode") return { ok: true, result: { nodeId: 7 } };
    if (method === "DOMDebugger.getEventListeners") return { ok: true, result: { listeners: [] } };
    return { ok: true, result: {} };
  };
  return { cdp, calls };
}

describe("every verb that takes an element finds it the way click does", () => {
  /*
   * `fill`, `wait`, `drag`, `scroll`, `upload`, `listeners`, `debug dom` and
   * `region` each built their own querySelector. Each one that did missed
   * something — the id rewrite, or the refusal when several match — and the
   * caller could not know which verb had which gap.
   */
  function twoButtons() {
    const body = h("body", {},
      h("label", { for: "email" }, "Email"),
      h("input", { id: "email", type: "email", "data-agx-e": "e2" }),
      h("input", { id: "file", type: "file" }),
      h("input", { id: "file2", type: "file" }),
      h("button", {}, "Save"),
      h("button", {}, "Save draft"),
    );
    return { body, ...page(body) };
  }

  test("fill takes an id from an observation", async () => {
    const { guest, body } = twoButtons();
    const r = await runBrowserAsk(guest, ask("fill", { fields: { e2: "ada@orbit.example" } }));
    expect(r.error).toBeUndefined();
    expect(body.querySelector("#email")!.events).toContain("input");
  });

  test("wait takes one too", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("wait", { selector: "e2" }));
    expect(r.ok).toBe(true);
  });

  test("wait says an unparseable selector is one, rather than waiting thirty seconds", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("wait", { selector: "a:has-text(Save)" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid selector");
  });

  test("scroll refuses to pick one of several, and names them", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("scroll", { selector: "button" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("matched 2 elements");
    expect(r.error).toContain('"Save draft"');
  });

  test("an id a refusal names is one the next call accepts", async () => {
    /* The refusal stamps the nodes it names; unless those ids go into the
       document's minted ranges, the id check refuses the very id the
       refusal said to use, as one from another page. */
    const { guest } = twoButtons();
    const many = await runBrowserAsk(guest, ask("scroll", { selector: "button" }));
    const id = /(e[0-9]+) button/.exec(String(many.error))?.[1];
    expect(id).not.toBeUndefined();
    const again = await runBrowserAsk(guest, ask("text", { selector: id! }));
    expect(again.error).toBeUndefined();
  });

  test("drag says which end it could not find, and why", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("drag", { selector: "e2", to: "button" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("the target of the drag");
    expect(r.error).toContain("matched 2 elements");
  });

  test("text still reads the first of several, as a read always has", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("text", { selector: "button" }));
    expect(r.ok).toBe(true);
    expect((r.value as { text: string }).text).toBe("Save");
  });

  test("upload refuses an ambiguous input through the protocol with the same sentence", async () => {
    const { guest } = twoButtons();
    const run = (code: string) => guest.executeJavaScript(code);
    const { cdp, calls } = cdpOver(run);
    const r = await runBrowserAsk(guest, ask("upload", { selector: "input[type=\"file\"]", paths: ["/tmp/a.txt"] }),
      undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("matched 2 elements");
    expect(calls).toEqual(["Runtime.evaluate"]);
  });

  test("listeners reach the node an id names", async () => {
    const { guest } = twoButtons();
    const { cdp, calls } = cdpOver((code) => guest.executeJavaScript(code));
    const r = await runBrowserAsk(guest, ask("listeners", { selector: "e2" }),
      undefined, undefined, undefined, cdp);
    expect(r.error).toBeUndefined();
    expect(calls).toEqual(["Runtime.evaluate", "DOMDebugger.getEventListeners"]);
  });

  test("region takes an id and a refusal says what it looked for", async () => {
    const { guest } = twoButtons();
    const r = await runBrowserAsk(guest, ask("region", { selector: "#nowhere" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nothing on the page matches #nowhere");
  });
});

describe("parseLocator: what a locator string means", () => {
  const cases: Array<[string, unknown]> = [
    ["e17", { css: '[data-agx-e="e17"]' }],
    ["#save", { css: "#save" }],
    ["button.primary", { css: "button.primary" }],
    // Only the lower-case prefixes, as Playwright spells them.
    ["ROLE=button", { css: "ROLE=button" }],
    ['role=button[name="Save"]', { by: "role", role: "button", name: "Save", exact: false }],
    ['role=button[name="Save" s]', { by: "role", role: "button", name: "Save", exact: true }],
    ['role=button[name="Save" i]', { by: "role", role: "button", name: "Save", exact: false }],
    ["role=button[name='It\\'s done']", { by: "role", role: "button", name: "It's done", exact: false }],
    ["role=button[name=Save draft]", { by: "role", role: "button", name: "Save draft", exact: false }],
    ["role=Dialog", { by: "role", role: "dialog", exact: false }],
    ["text=Continue", { by: "text", value: "Continue", exact: false }],
    ['text="Continue"', { by: "text", value: "Continue", exact: true }],
    ["label=Email", { by: "label", value: "Email", exact: false }],
    ["label=a=b", { by: "label", value: "a=b", exact: false }],
    ["placeholder=Search", { by: "placeholder", value: "Search", exact: false }],
    // A test id is a hook put there on purpose: always exact.
    ["testid=submit", { by: "testid", value: "submit", exact: true }],
  ];
  for (const [raw, want] of cases) {
    test(raw, () => expect(parseLocator(raw)).toEqual(want as never));
  }

  const refused: Array<[string, string]> = [
    ["role=", "needs a role"],
    ["role=button[level=2]", "nothing else"],
    ['role=button[name="Save"', "expects ]"],
    ['role=button[name="Save"] extra', "expects ]"],
    ["role=button[name=]", "empty name"],
    ['role=button[name=""]', "empty name"],
    ["text=", "needs something to look for"],
    ['text="unclosed', "never closed"],
    ['text="Save" now', "after its closing quote"],
  ];
  for (const [raw, why] of refused) {
    test(`${raw} is refused, and says why`, () => {
      const r = parseLocator(raw) as { invalid?: string };
      expect(r.invalid).toBeDefined();
      expect(r.invalid!).toContain(why);
    });
  }
});

/** A page with the things locators are for: buttons that share a word, a
 *  labelled form, a hidden twin, a link, a heading, an ARIA widget. */
function app() {
  const emailLabel = h("label", { for: "email" }, "Email address");
  const email = h("input", { id: "email", type: "email" });
  email.labels = [emailLabel];
  const planLabel = h("label", { for: "plan" }, "Plan");
  const plan = h("select", { id: "plan" });
  plan.labels = [planLabel];
  plan.options = [{ value: "", text: "Choose…" }, { value: "team", text: "Team" }];
  const termsLabel = h("label", { for: "terms" }, "I accept the terms");
  const terms = h("input", { id: "terms", type: "checkbox" });
  terms.labels = [termsLabel];
  const hiddenDelete = h("button", {}, "Delete");
  hiddenDelete.style.display = "none";
  const body = h("body", {},
    h("h1", {}, "Orbit settings"),
    h("nav", {}, h("a", { href: "/docs" }, "Docs"), h("a", {}, "Not a link")),
    h("span", { id: "cardno" }, "Card number"),
    h("input", { id: "card", "aria-labelledby": "cardno" }),
    h("input", { id: "q", type: "search", placeholder: "Search projects" }),
    emailLabel, email, planLabel, plan, terms, termsLabel,
    h("button", { "data-testid": "save" }, "Save"),
    h("button", {}, "Save draft"),
    h("button", {}, h("span", {}, "Continue")),
    h("input", { type: "submit", value: "Send invite" }),
    h("div", { role: "button", "aria-label": "Close panel" }),
    hiddenDelete,
    h("p", {}, "Saved 2 minutes ago"),
  );
  return { body, email, plan, terms, hiddenDelete, ...page(body) };
}

const byText = (body: N, text: string) => body.all().find((n) => n.text === text)!;

describe("a locator finds what a person would point at", () => {
  test("role + name: the button called Save, not Save draft next to it", async () => {
    const { guest, body } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Save"]' }));
    expect(r.error).toBeUndefined();
    expect(byText(body, "Save").events).toContain("click");
    expect(byText(body, "Save draft").events).not.toContain("click");
  });

  test("a name is a case-insensitive substring, so part of one is fine when it is only one", async () => {
    const { guest, body } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="draft"]' }));
    expect(r.error).toBeUndefined();
    expect(byText(body, "Save draft").events).toContain("click");
  });

  test("and two that fit with neither being the whole name are refused, with ids to use instead", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Sav"]' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("matched 2 elements");
    expect(r.error).toMatch(/e[0-9]+ button[^,]*"Save"/);
    expect(r.error).toMatch(/e[0-9]+ button[^,]*"Save draft"/);
    expect(r.error).toContain("use one of the ids");
  });

  test("the s flag is exact and case-sensitive", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("focus", { selector: 'role=button[name="save" s]' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing on the page matches");
  });

  test("ARIA's role names and the ones observe prints both work", async () => {
    const { guest } = app();
    for (const selector of ['role=link[name="Docs"]', 'role=a[name="Not a link"]', 'role=heading[name="Orbit settings"]',
      'role=textbox[name="Email"]', 'role=combobox[name="Plan"]', 'role=checkbox[name="terms"]',
      'role=searchbox', 'role=button[name="Close panel"]']) {
      const r = await runBrowserAsk(guest, ask("focus", { selector }));
      expect(r.error, selector).toBeUndefined();
    }
    // An <a> with no href is not a link, which is ARIA's rule too.
    const r = await runBrowserAsk(guest, ask("focus", { selector: 'role=link[name="Not a link"]' }));
    expect(r.ok).toBe(false);
  });

  test("label= types into the field its <label> names, and select takes one too", async () => {
    const { guest, email, plan } = app();
    const t = await runBrowserAsk(guest, ask("type", { selector: "label=Email", text: "ada@orbit.example" }));
    expect(t.error).toBeUndefined();
    expect(email.events).toContain("input");
    const s = await runBrowserAsk(guest, ask("select", { selector: "label=Plan", value: "team" }));
    expect(s.error).toBeUndefined();
    expect(plan.value).toBe("team");
  });

  test("label= reads aria-labelledby", async () => {
    const { guest, body } = app();
    const r = await runBrowserAsk(guest, ask("focus", { selector: "label=Card number" }));
    expect(r.error).toBeUndefined();
    expect(body.querySelector("#card")!.events).toContain("focus");
  });

  test("check by label", async () => {
    const { guest, terms } = app();
    const r = await runBrowserAsk(guest, ask("check", { selector: 'label="I accept the terms"' }));
    expect(r.error).toBeUndefined();
    expect(terms.events).toContain("change");
  });

  test("placeholder= and testid=", async () => {
    const { guest, body } = app();
    expect((await runBrowserAsk(guest, ask("focus", { selector: "placeholder=search" }))).error).toBeUndefined();
    expect(body.querySelector("#q")!.events).toContain("focus");
    expect((await runBrowserAsk(guest, ask("focus", { selector: "testid=save" }))).error).toBeUndefined();
    // Exact: part of a test id is not the test id.
    expect((await runBrowserAsk(guest, ask("focus", { selector: "testid=sav" }))).ok).toBe(false);
  });

  test("text= lands on the innermost element with that text", async () => {
    const { guest, body } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: "text=Continue" }));
    expect(r.error).toBeUndefined();
    const span = byText(body, "Continue");
    expect(span.tagName).toBe("SPAN");
    expect(span.events).toContain("click");
  });

  test("text= reads a submit button's value, and a quoted text is the whole text", async () => {
    const { guest } = app();
    expect((await runBrowserAsk(guest, ask("focus", { selector: "text=send invite" }))).error).toBeUndefined();
    // "Save" alone is on the page twice as a substring (Save, Save draft,
    // Saved 2 minutes ago) but once as a whole text.
    expect((await runBrowserAsk(guest, ask("focus", { selector: 'text="Save"' }))).error).toBeUndefined();
    const sub = await runBrowserAsk(guest, ask("focus", { selector: "text=ave" }));
    expect(sub.ok).toBe(false);
    expect(sub.error).toContain("matched 3 elements");
  });

  test("a match that is hidden is named, not silently dropped", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Delete"]' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("on screen — 1 hidden");
    expect(r.error).toMatch(/e[0-9]+ button[^,]*"Delete"/);
  });

  test("nothing matching says what of that kind IS there", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Publish"]' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("role=button on this page:");
    expect(r.error).toContain('"Save draft"');
    const l = await runBrowserAsk(guest, ask("focus", { selector: "label=Phone" }));
    expect(l.error).toContain("labels on this page:");
    expect(l.error).toContain('"Email address"');
  });

  test("a locator that does not parse is refused with the parser's reason", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("click", { selector: "role=button[level=1]" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid selector "role=button[level=1]"');
    expect(r.error).toContain("nothing else");
  });

  test("a read verb refuses an ambiguous locator, though it takes the first of an ambiguous CSS selector", async () => {
    const { guest } = app();
    const loc = await runBrowserAsk(guest, ask("text", { selector: "role=button" }));
    expect(loc.ok).toBe(false);
    expect(loc.error).toContain("matched");
    const css = await runBrowserAsk(guest, ask("text", { selector: "button" }));
    expect(css.ok).toBe(true);
  });

  test("wait counts several as appeared", async () => {
    const { guest } = app();
    const r = await runBrowserAsk(guest, ask("wait", { selector: "role=button" }));
    expect(r.ok).toBe(true);
  });

  test("fill takes locators, drag takes them at both ends", async () => {
    const { guest, email } = app();
    const f = await runBrowserAsk(guest, ask("fill", { fields: { "label=Email": "ada@orbit.example", "placeholder=Search": "orbit" } }));
    expect(f.error).toBeUndefined();
    expect((f.value as { filled: string[] }).filled).toEqual(["label=Email", "placeholder=Search"]);
    expect(email.events).toContain("input");
    const d = await runBrowserAsk(guest, ask("drag", { selector: "text=Continue", to: 'role=button[name="Nowhere"]' }));
    expect(d.ok).toBe(false);
    expect(d.error).toContain('the target of the drag: nothing on the page matches role=button[name="Nowhere"]');
  });

  test("upload finds its input by label through the protocol", async () => {
    const fileLabel = h("label", {}, "Attachment");
    const input = h("input", { type: "file" });
    input.labels = [fileLabel];
    // The usual kind: display:none behind a styled button.
    input.style.display = "none";
    const { guest } = page(h("body", {}, fileLabel, input));
    const { cdp, calls } = cdpOver((code) => guest.executeJavaScript(code));
    const r = await runBrowserAsk(guest, ask("upload", { selector: "label=Attachment", paths: ["/tmp/a.txt"] }),
      undefined, undefined, undefined, cdp);
    expect(calls[0]).toBe("Runtime.evaluate");
    expect(calls).toContain("DOM.requestNode");
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});

describe("a hostile locator stays data", () => {
  const PAYLOADS = [
    'text=x"); globalThis.__canary.hit = 1; ("',
    'role=button[name="a\\"]"); globalThis.__canary.hit = 1; //"]',
    "label=</script><img src=x onerror=\"globalThis.__canary.hit = 1\">",
    "placeholder=a\u2028globalThis.__canary.hit = 1;//",
    "testid=a`${globalThis.__canary.hit = 1}`",
  ];
  for (const payload of PAYLOADS) {
    test(JSON.stringify(payload), async () => {
      const g = globalThis as unknown as { __canary: { hit: number } };
      g.__canary = { hit: 0 };
      const { guest } = app();
      // Not wait: a locator that parses and matches nothing polls for 30 s.
      for (const op of ["click", "type", "text", "scroll", "select"]) {
        await runBrowserAsk(guest, ask(op, { selector: payload, text: "x", value: "x" }));
      }
      expect(g.__canary.hit).toBe(0);
      for (const code of guest.ran) {
        expect(code).not.toContain("<");
        expect(code).not.toContain("\u2028");
      }
    });
  }
});

describe("fill says which fields were secret, as type does", () => {
  /*
   * The relay redacts a logged value when the selector looks like a secret
   * (`#password`) or the panel says the node was one. `type` has always said;
   * `fill` never did, so `fill --field 'e7=…'` or `label=Passphrase…` into a
   * password field reached the audit log intact whenever the selector's words
   * did not give it away. The relay already reads `secretFields`.
   */
  test("a password field is named by the selector the caller used", async () => {
    const pinLabel = h("label", {}, "Access code");
    const pin = h("input", { type: "password" });
    pin.labels = [pinLabel];
    const otp = h("input", { id: "otp", autocomplete: "one-time-code" });
    const { guest } = page(h("body", {}, h("input", { id: "name" }), pinLabel, pin, otp));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "#name": "Ada", "label=Access code": "4242", "#otp": "123456" } }));
    expect(r.error).toBeUndefined();
    expect((r.value as { secretFields?: string[] }).secretFields).toEqual(["label=Access code", "#otp"]);
  });
});

describe("what the review of the first version found", () => {
  test("a hidden whole name is refused as hidden, not answered with a visible part-match", async () => {
    const save = h("button", {}, "Save");
    save.style.display = "none";
    const draft = h("button", {}, "Save draft");
    const { guest } = page(h("body", {}, save, draft));
    for (const selector of ['role=button[name="Save"]', "text=Save"]) {
      const r = await runBrowserAsk(guest, ask("click", { selector }));
      expect(r.ok, selector).toBe(false);
      expect(r.error, selector).toContain("1 hidden");
      expect(draft.events).not.toContain("click");
    }
  });

  test("a hidden or one-pixel child does not take the place of the visible element around it", async () => {
    const tip = h("span", {}, " Save changes");
    tip.style.display = "none";
    const sr = h("span", { class: "sr-only" }, "Close panel");
    sr.box = { width: 1, height: 1 };
    const save = h("button", {}, "Save", tip);
    const close = h("button", {}, h("svg", {}), sr);
    const { guest } = page(h("body", {}, save, close));
    expect((await runBrowserAsk(guest, ask("click", { selector: "text=Save" }))).error).toBeUndefined();
    expect(save.events).toContain("click");
    expect((await runBrowserAsk(guest, ask("click", { selector: "text=Close panel" }))).error).toBeUndefined();
    expect(close.events).toContain("click");
  });

  test("text= does not read the text of every element on the page", async () => {
    const sections = Array.from({ length: 50 }, (_, i) => {
      let n = h("div", {}, `item ${i}`);
      for (let d = 0; d < 20; d++) n = h("div", {}, n);
      return n;
    });
    const target = h("button", {}, "Checkout");
    const { guest } = page(h("body", {}, ...sections, target));
    N.reads = 0;
    const r = await runBrowserAsk(guest, ask("focus", { selector: "text=Checkout" }));
    expect(r.error).toBeUndefined();
    // 1051 elements; one read per top-level subtree and the path to the hit.
    // Reading every element would be well over a thousand.
    expect(N.reads).toBeLessThan(200);
  });

  test("landmark roles and an image's alt", async () => {
    const { guest } = page(h("body", {},
      h("dialog", { "aria-label": "Invite" }, h("p", {}, "Invite a teammate")),
      h("img", { alt: "Orbit logo" }),
      h("nav", {}, h("a", { href: "/" }, "Home")),
    ));
    for (const selector of ['role=dialog[name="Invite"]', 'role=img[name="Orbit logo"]', "role=navigation"]) {
      expect((await runBrowserAsk(guest, ask("focus", { selector }))).error, selector).toBeUndefined();
    }
  });

  test("a label that wraps its select is read without the options", async () => {
    const plan = h("select", {});
    plan.text = "Team Solo";
    plan.options = [{ value: "team", text: "Team" }, { value: "solo", text: "Solo" }];
    const label = h("label", {}, "Plan ", plan);
    plan.labels = [label];
    const { guest } = page(h("body", {}, label));
    const r = await runBrowserAsk(guest, ask("select", { selector: 'label="Plan"', value: "solo" }));
    expect(r.error).toBeUndefined();
    expect(plan.value).toBe("solo");
  });

  test("fill that cannot find a later field writes none of them, so trying again types nothing twice", async () => {
    const pinLabel = h("label", {}, "Access code");
    const pin = h("input", { type: "password" });
    pin.labels = [pinLabel];
    const { guest } = page(h("body", {}, pinLabel, pin));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "label=Access code": "4242", "#nowhere": "x" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#nowhere");
    expect(pin.value).toBe("");
    expect(pin.events).toEqual([]);
  });

  test("a refusal describes an input by what it is, never by what was typed into it", async () => {
    /* The refusal lists the candidates so the caller can narrow the
       selector. An input has no text, and describing it by its value put a
       password that had just been filled into the error — which the audit
       log keeps. */
    const l1 = h("label", {}, "Password");
    const p1 = h("input", { type: "password", id: "p1", name: "pw" });
    p1.labels = [l1];
    const l2 = h("label", {}, "Password");
    const p2 = h("input", { type: "password", id: "p2", placeholder: "Repeat it" });
    p2.labels = [l2];
    const { guest } = page(h("body", {}, l1, p1, l2, p2));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "#p1": "Hunter2secret", "#p2": "Hunter2secret", "label=Password": "x" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("matched 2 elements");
    expect(r.error).not.toContain("Hunter2secret");
    expect(r.error).toContain("type=password");
  });

  test("a submit input is still described by its label, which is its value", async () => {
    const { guest } = page(h("body", {}, h("input", { type: "submit", value: "Save" }), h("input", { type: "submit", value: "Save" })));
    const r = await runBrowserAsk(guest, ask("click", { selector: "input" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"Save"');
  });

  test("the hostile suite reaches fill and drag too", async () => {
    const g = globalThis as unknown as { __canary: { hit: number } };
    g.__canary = { hit: 0 };
    const { guest } = app();
    const p = 'text=x"); globalThis.__canary.hit = 1; ("';
    await runBrowserAsk(guest, ask("fill", { fields: { [p]: "</script>" } }));
    await runBrowserAsk(guest, ask("drag", { selector: p, to: p }));
    expect(g.__canary.hit).toBe(0);
    // drag's own code has comparisons in it, so the check is the payload's.
    for (const code of guest.ran) expect(code).not.toContain("</script>");
  });
});

describe("an act verb waits for the page to catch up, never for input it already sent", () => {
  test("a button that renders a moment late is clicked, not refused", async () => {
    const save = h("button", {}, "Save");
    const body = h("body", {});
    const { guest } = page(body);
    const run = guest.executeJavaScript;
    let calls = 0;
    guest.executeJavaScript = async (code: string) => {
      if (++calls === 2) { save.parentElement = body; body.children.push(save); }
      return run(code);
    };
    setFindWaitMs(2000);
    try {
      const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Save"]' }));
      expect(r.error).toBeUndefined();
      expect(save.events).toContain("click");
    } finally { setFindWaitMs(0); }
  });

  test("of three that match, the one that can be acted on is the one", async () => {
    const mobile = h("button", { class: "buy" }, "Buy");
    mobile.style.display = "none";
    const off = h("button", { class: "buy" }, "Buy");
    off.disabled = true;
    const real = h("button", { class: "buy" }, "Buy");
    const { guest } = page(h("body", {}, mobile, off, real));
    const r = await runBrowserAsk(guest, ask("click", { selector: "button" }));
    expect(r.error).toBeUndefined();
    expect(real.events).toContain("click");
    expect(mobile.events).toEqual([]);
    expect(off.events).toEqual([]);
  });

  test("two that can both be acted on are still refused, with ids", async () => {
    const { guest } = page(h("body", {}, h("button", {}, "A"), h("button", {}, "B")));
    const r = await runBrowserAsk(guest, ask("click", { selector: "button" }));
    expect(r.error).toContain("matched 2 elements");
  });

  test("disabled is inherited: from an aria-disabled group, and from a disabled fieldset", async () => {
    const inGroup = h("button", {}, "Next");
    const inSet = h("button", {}, "Send");
    const { guest } = page(h("body", {},
      h("div", { "aria-disabled": "true" }, inGroup),
      h("fieldset", { disabled: "" }, inSet),
    ));
    const a = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Next"]' }));
    expect(a.error).toContain("disabled");
    const b = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Send"]' }));
    expect(b.error).toContain("disabled");
    expect(inGroup.events).not.toContain("click");
    expect(inSet.events).not.toContain("click");
  }, 10_000);

  test("an overlay that goes away is waited out, not reported as the answer", async () => {
    const save = h("button", {}, "Save changes");
    const veil = h("div", { class: "toast-veil" });
    const { guest, doc } = page(h("body", {}, save, veil));
    let looks = 0;
    doc.elementFromPoint = () => (++looks > 3 ? save : veil);
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Save changes"]' }));
    expect(r.error).toBeUndefined();
    expect(save.events).toContain("click");
  });

  test("an overlay that stays is still named when the wait runs out", async () => {
    const save = h("button", {}, "Save changes");
    const veil = h("div", { class: "modal-backdrop" });
    const { guest, doc } = page(h("body", {}, save, veil));
    doc.elementFromPoint = () => veil;
    const r = await runBrowserAsk(guest, ask("click", { selector: 'role=button[name="Save changes"]' }));
    expect(r.error).toContain("covered by div.modal-backdrop");
    expect(save.events).not.toContain("click");
  }, 10_000);
});

describe("a receipt says what a look would have told you", () => {
  test("fill reads each field back and names the ones the page changed", async () => {
    const name = h("input", { id: "name" });
    const phone = h("input", { id: "phone" });
    let held = "";
    Object.defineProperty(phone, "value", { get: () => held, set: (v: string) => { held = "(555) " + v; } });
    const { guest } = page(h("body", {}, name, phone));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "#name": "Ada", "#phone": "0100" } }));
    expect(r.error).toBeUndefined();
    expect((r.value as { changedByPage?: unknown }).changedByPage).toEqual({ "#phone": "reformatted" });
    expect(JSON.stringify(r)).not.toContain("(555)");
  });

  test("and a value the page changed is named by kind, never shown", async () => {
    const pw = h("input", { id: "pw", type: "password" });
    let held = "";
    Object.defineProperty(pw, "value", { get: () => held, set: (v: string) => { held = v.slice(0, 4); } });
    const { guest } = page(h("body", {}, pw));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "#pw": "orbit-pass-1" } }));
    expect((r.value as { changedByPage?: unknown }).changedByPage).toEqual({ "#pw": "cut short" });
    expect(JSON.stringify(r)).not.toContain("orbi");
  });

  test("fill that took every value as typed says nothing more", async () => {
    const { guest } = page(h("body", {}, h("input", { id: "name" })));
    const r = await runBrowserAsk(guest, ask("fill", { fields: { "#name": "Ada" } }));
    expect((r.value as { changedByPage?: unknown }).changedByPage).toBeUndefined();
  });

  test("an id that was re-rendered is answered with the one that took its place, and nothing is clicked", async () => {
    const fresh = h("button", {}, "Save");
    const body = h("body", {}, h("button", { "data-agx-e": "e5" }, "Save"));
    const { guest, win } = page(body);
    body.children = [fresh];
    fresh.parentElement = body;
    win.__agxLast = { "": { tree: [{ e: "e5", role: "button", name: "Save" }] } };
    const r = await runBrowserAsk(guest, ask("click", { selector: "e5" }));
    expect(r.ok).toBe(false);
    const m = /button "Save" is now (e[0-9]+)/.exec(r.error ?? "");
    expect(m).not.toBeNull();
    expect(fresh.events).not.toContain("click");
    const again = await runBrowserAsk(guest, ask("click", { selector: m![1]! }));
    expect(again.error).toBeUndefined();
    expect(fresh.events).toContain("click");
  });

  test("and with two that could have taken it, the refusal stays the plain one", async () => {
    const body = h("body", {}, h("button", { "data-agx-e": "e5" }, "Save"));
    const { guest, win } = page(body);
    const a = h("button", {}, "Save"), b = h("button", {}, "Save");
    body.children = [a, b];
    a.parentElement = body; b.parentElement = body;
    win.__agxLast = { "": { tree: [{ e: "e5", role: "button", name: "Save" }] } };
    const r = await runBrowserAsk(guest, ask("click", { selector: "e5" }));
    expect(r.error).toContain("no longer in the page");
    expect(r.error).not.toContain("is now");
  });
});
