/*
 * A stand-in page for the suites that run the driver's real page scripts: nodes
 * with the handful of properties the scripts read, a document that answers the
 * few selector shapes they ask, a window. Shared by the locator and the
 * shadow/frame suites so the two cannot drift into two fakes.
 */
import type { DrivableWebview } from "../src/lib/browserDrive.ts";

export type Style = { display?: string; visibility?: string };

export class N {
  tagName: string;
  attrs: Record<string, string> = {};
  children: N[] = [];
  parentElement: N | null = null;
  text = "";
  style: Style = {};
  box = { width: 100, height: 20 };
  pos = { x: 10, y: 10 };
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
  /* An open shadow root hangs off its host; a same-origin frame's document off
     the iframe. `crossOrigin` makes contentDocument throw, as a real one does. */
  shadowRoot: Root | null = null;
  frameDoc: Root | null = null;
  crossOrigin = false;
  _root: Root | null = null;
  constructor(tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    if (tag === "input") this.type = attrs.type ?? "text";
    if (attrs.value !== undefined) this.value = attrs.value;
    for (const k of kids) {
      if (typeof k === "string") this.text += k;
      else { k.parentElement = this; this.children.push(k); }
    }
    /* STAMP writes `dataset.agxE`, and a CSS lookup reads `data-agx-e`: the
       same attribute, as in a page. */
    const key = (k: string) => "data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => this.attrs[key(k)],
      set: (_t, k: string, v: string) => { this.attrs[key(k)] = v; return true; },
    });
  }
  get id() { return this.attrs.id ?? ""; }
  get contentDocument(): Root | null {
    if (this.crossOrigin) throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
    return this.frameDoc;
  }
  private top(): N { return this.parentElement ? this.parentElement.top() : this; }
  /* Only a node inside a shadow root or a frame answers: the main page has no
     root object here, and a caller falls back to the document. */
  getRootNode(): Root | null { return this.top()._root; }
  get ownerDocument(): Root | undefined {
    const r = this.top()._root;
    return r && r.isFrame ? r : undefined;
  }
  /* How many times a script asked a node for its text — one native call in
     a page, however deep the node, so the recursion below counts once. */
  static reads = 0;
  static depth = 0;
  get textContent(): string {
    if (N.depth === 0) N.reads++;
    N.depth++;
    try { return this.text + this.children.map((c) => c.textContent).join(""); } finally { N.depth--; }
  }
  /* Chromium's rule: a node that is not rendered answers with its
     textContent; one that is leaves out its children that are not. */
  get innerText(): string {
    if (!this.shown()) return this.textContent;
    return this.text + this.children.map((c) => (c.shown() ? c.innerText : "")).join("");
  }
  get className() { return this.attrs.class ?? ""; }
  get form() { return null; }
  get autocomplete() { return this.attrs.autocomplete ?? ""; }
  shown(): boolean {
    return this.style.display !== "none" && (!this.parentElement || this.parentElement.shown());
  }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  hasAttribute(k: string) { return k in this.attrs; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  matches(sel: string): boolean { return matches(this, sel); }
  closest(sel: string): N | null {
    if (matches(this, sel)) return this;
    return this.parentElement ? this.parentElement.closest(sel) : null;
  }
  contains(o: N | null): boolean {
    for (let n = o; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  getBoundingClientRect() {
    const w = this.shown() ? this.box.width : 0, h = this.shown() ? this.box.height : 0;
    const { x, y } = this.pos;
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
  }
  getClientRects() { return this.shown() ? [this.getBoundingClientRect()] : []; }
  scrollIntoView() {}
  focus() { this.events.push("focus"); }
  blur() { this.events.push("blur"); }
  click() { this.events.push("click"); }
  dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; }
  all(): N[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  /** Every node under this one, including the ones inside shadow roots and frames. */
  deep(): N[] {
    return this.all().flatMap((n) => [n, ...(n.shadowRoot ? n.shadowRoot.deep() : []), ...(n.frameDoc ? n.frameDoc.deep() : [])]);
  }
  querySelectorAll(sel: string): N[] { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel: string): N | null { return this.querySelectorAll(sel)[0] ?? null; }
}

/** A shadow root or a frame's document: a tree of its own that the main
 *  document's querySelectorAll does not reach. */
export class Root {
  children: N[];
  isFrame: boolean;
  nodeType: number;
  body: N | null = null;
  defaultView: Record<string, unknown> | null = null;
  elementFromPoint: () => N | null = () => null;
  constructor(kind: "shadow" | "frame", ...kids: N[]) {
    this.isFrame = kind === "frame";
    this.nodeType = this.isFrame ? 9 : 11;
    this.children = kids;
    for (const k of kids) { k.parentElement = null; k._root = this; }
    if (this.isFrame) {
      this.body = kids[0] ?? null;
      this.defaultView = { innerWidth: 400, innerHeight: 300, HTMLInputElement: class {}, HTMLTextAreaElement: class {} };
    }
  }
  all(): N[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  deep(): N[] { return this.all().flatMap((n) => [n, ...(n.shadowRoot ? n.shadowRoot.deep() : []), ...(n.frameDoc ? n.frameDoc.deep() : [])]); }
  querySelectorAll(sel: string): N[] { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel: string): N | null { return this.querySelectorAll(sel)[0] ?? null; }
  getElementById(id: string): N | null { return this.all().find((n) => n.id === id) ?? null; }
}

/** The selector shapes the driver's scripts ask for: `*`, a tag, `#id`,
 *  `[attr]`, `[attr="v"]`, and comma lists of those. Anything else is a
 *  syntax error, as a real page would say about a selector it cannot parse. */
export function matches(n: N, sel: string): boolean {
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

export const h = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<N | string>) => new N(tag, attrs, ...kids);

/** A page over `body`. A new page is a new window, which is what a navigation is. */
export function page(body: N) {
  const html = h("html", {}, body);
  const doc = {
    body, documentElement: html, title: "The app",
    querySelectorAll: (s: string) => html.querySelectorAll(s),
    querySelector: (s: string) => html.querySelector(s),
    getElementById: (id: string) => html.all().find((n) => n.id === id) ?? null,
    elementFromPoint: (): N | null => null,
    visibilityState: "visible", readyState: "complete", cookie: "", hasFocus: () => true,
  };
  const win: Record<string, unknown> = { scrollY: 0, innerHeight: 800, scrollTo() {}, scrollBy() {} };
  /* Ids stamped in a fixture stand for an observe of THIS page, so the page
     carries the record an observe leaves (the counter and the range it
     minted): an id is asked where it came from before it is acted on, and
     one no observe of this document minted is refused as foreign. */
  const stamped = html.deep().map((n) => Number(/^e([0-9]+)$/.exec(n.attrs["data-agx-e"] ?? "")?.[1] ?? 0));
  const top = Math.max(0, ...stamped);
  if (top) { win.__agxSeq = top; win.__agxRanges = [[1, top]]; }
  const globals: Record<string, unknown> = {
    document: doc, window: win,
    getComputedStyle: (n: N) => ({
      display: n.style.display ?? "block", visibility: n.style.visibility ?? "visible", opacity: "1",
    }),
    innerWidth: 1280, innerHeight: 800,
    localStorage: {}, sessionStorage: {}, crypto: globalThis.crypto,
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
  for (const n of html.deep()) { if (n.shadowRoot) n.shadowRoot.elementFromPoint = () => looking; if (n.frameDoc) n.frameDoc.elementFromPoint = () => looking; }
  const guest = {
    ran: [] as string[],
    loadURL: async () => {}, goBack: () => {}, goForward: () => {},
    canGoBack: () => false, canGoForward: () => false, reload: () => {}, reloadIgnoringCache: () => {},
    getURL: () => "https://orbit.example/app", getTitle: () => "The app",
    isLoading: () => false,
    executeJavaScript: async (code: string) => {
      guest.ran.push(code);
      // Whatever element the script scrolled to is the one on top.
      for (const n of html.deep()) n.scrollIntoView = () => { looking = n; };
      return await run(code);
    },
    capturePage: async () => ({ toDataURL: () => "" }),
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as DrivableWebview & { ran: string[] };
  return { guest, doc, win };
}

