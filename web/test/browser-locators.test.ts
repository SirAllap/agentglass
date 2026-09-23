/*
 * How a verb finds the element it acts on.
 *
 * There is no DOM in these suites, so the scripts the driver builds are run
 * against a small stand-in page: nodes with the handful of properties the
 * scripts read, a document that answers the few selector shapes they ask, a
 * window. The script is the real string handed to executeJavaScript — the
 * thing under test is what it finds, which reading its source cannot pin.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";

type Style = { display?: string; visibility?: string };

class N {
  tagName: string;
  attrs: Record<string, string> = {};
  children: N[] = [];
  parentElement: N | null = null;
  text = "";
  style: Style = {};
  size = { width: 100, height: 20 };
  events: string[] = [];
  value = "";
  type = "";
  checked = false;
  disabled = false;
  multiple = false;
  labels: N[] = [];
  options: Array<{ value: string; text: string }> = [];
  dataset: Record<string, string>;
  nodeType = 1;
  constructor(tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    if (tag === "input") this.type = attrs.type ?? "text";
    if (attrs.value !== undefined) this.value = attrs.value;
    for (const k of kids) {
      if (typeof k === "string") this.text += k;
      else { k.parentElement = this; this.children.push(k); }
    }
    const node = this;
    /* STAMP writes `dataset.agxE`, and a CSS lookup reads `data-agx-e`: the
       same attribute, as in a page. */
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => node.attrs["data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())],
      set: (_t, k: string, v: string) => { node.attrs["data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = v; return true; },
    });
  }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  get innerText(): string { return this.shown() ? this.text + this.children.map((c) => c.innerText).join("") : ""; }
  get className() { return this.attrs.class ?? ""; }
  get form() { return null; }
  get autocomplete() { return this.attrs.autocomplete ?? ""; }
  shown(): boolean {
    return this.style.display !== "none" && (!this.parentElement || this.parentElement.shown());
  }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  hasAttribute(k: string) { return k in this.attrs; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  contains(o: N | null): boolean {
    for (let n = o; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  getBoundingClientRect() {
    const w = this.shown() ? this.size.width : 0, h = this.shown() ? this.size.height : 0;
    return { x: 10, y: 10, left: 10, top: 10, width: w, height: h, right: 10 + w, bottom: 10 + h };
  }
  getClientRects() { return this.shown() ? [this.getBoundingClientRect()] : []; }
  scrollIntoView() {}
  focus() { this.events.push("focus"); }
  blur() { this.events.push("blur"); }
  click() { this.events.push("click"); }
  dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; }
  all(): N[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel: string): N[] { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel: string): N | null { return this.querySelectorAll(sel)[0] ?? null; }
}

/** The selector shapes the driver's scripts ask for: `*`, a tag, `#id`,
 *  `[attr]`, `[attr="v"]`, and comma lists of those. Anything else is a
 *  syntax error, as a real page would say about a selector it cannot parse. */
function matches(n: N, sel: string): boolean {
  return sel.split(",").map((s) => s.trim()).some((one) => {
    const m = /^([a-z0-9*]*)((?:#[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(one);
    if (!m || !one) throw new SyntaxError(`'${one}' is not a valid selector`);
    const [, tag, rest] = m;
    if (tag && tag !== "*" && n.tagName !== tag.toUpperCase()) return false;
    for (const part of rest!.match(/#[\w-]+|\[[^\]]+\]/g) ?? []) {
      if (part.startsWith("#")) { if (n.id !== part.slice(1)) return false; continue; }
      const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)!;
      if (!(k! in n.attrs)) return false;
      if (v !== undefined && n.attrs[k!] !== v) return false;
    }
    return true;
  });
}

const h = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) => new N(tag, attrs, ...kids);

/** A page over `body`. A new page is a new window, which is what a navigation is. */
function page(body: N) {
  const html = h("html", {}, body);
  const doc = {
    body, documentElement: html, title: "The app",
    querySelectorAll: (s: string) => html.querySelectorAll(s),
    querySelector: (s: string) => html.querySelector(s),
    getElementById: (id: string) => html.all().find((n) => n.id === id) ?? null,
    elementFromPoint: (): N | null => null,
  };
  const win: Record<string, unknown> = { scrollY: 0, innerHeight: 800, scrollTo() {}, scrollBy() {} };
  const globals: Record<string, unknown> = {
    document: doc, window: win,
    getComputedStyle: (n: N) => ({
      display: n.style.display ?? "block", visibility: n.style.visibility ?? "visible", opacity: "1",
    }),
    innerWidth: 1280, innerHeight: 800,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    Event: class { constructor(public type: string) {} },
    MouseEvent: class { constructor(public type: string) {} },
    KeyboardEvent: class { constructor(public type: string) {} },
    setTimeout, Date, location: { href: "https://orbit.example/app" },
  };
  const run = (code: string) =>
    new Function(...Object.keys(globals), `return ${code}`)(...Object.values(globals)) as unknown;
  /* The actionability gate asks what is on top at the element's centre: the
     element it is looking at, in a page with nothing covering anything. */
  let looking: N | null = null;
  doc.elementFromPoint = () => looking;
  const guest = {
    ran: [] as string[],
    loadURL: async () => {}, goBack: () => {}, goForward: () => {},
    canGoBack: () => false, canGoForward: () => false, reload: () => {}, reloadIgnoringCache: () => {},
    getURL: () => "https://orbit.example/app", getTitle: () => "The app",
    isLoading: () => false,
    executeJavaScript: async (code: string) => {
      guest.ran.push(code);
      // Whatever element the script scrolled to is the one on top.
      for (const n of html.all()) n.scrollIntoView = () => { looking = n; };
      return await run(code);
    },
    capturePage: async () => ({ toDataURL: () => "" }),
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as DrivableWebview & { ran: string[] };
  return { guest, doc, win };
}

const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

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
