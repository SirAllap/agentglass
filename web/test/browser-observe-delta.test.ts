/*
 * `observe --delta`: what changed since the caller's last look at the same
 * document, computed in the page.
 *
 * There is no DOM in these suites, so the observe script is run against a
 * small stand-in page: elements with the handful of properties the script
 * reads, a document, a window. The script is the real string the driver hands
 * to executeJavaScript — the thing under test is what it does across two
 * calls, which no amount of reading its source can pin.
 */
import { describe, expect, test } from "bun:test";
import { callerKey, runBrowserAsk } from "../src/lib/browserDrive.ts";
import { OBSERVE_DIFF, STAMP, observeScript, type ObserveOpts } from "../src/lib/browserObserve.ts";

type FakeEl = {
  tagName: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  id: string;
  innerText: string;
  disabled?: boolean;
  name?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  rect: { x: number; y: number; width: number; height: number };
  getAttribute(k: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  contains(o: unknown): boolean;
};

let made = 0;
function el(tag: string, text = "", extra: Partial<FakeEl> & { attrs?: Record<string, string> } = {}): FakeEl {
  const y = 10 + 30 * made++;
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    attrs: {},
    dataset: {},
    id: "",
    innerText: text,
    rect: { x: 10, y, width: 120, height: 20 },
    getAttribute(k) { return this.attrs[k] ?? null; },
    getBoundingClientRect() { return this.rect; },
    contains(o) { return o === this; },
    ...extra,
  };
  if (["input", "select", "textarea"].includes(tag) && node.type === undefined) node.type = tag === "input" ? "text" : tag;
  return node;
}

const PICKED = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "H1", "H2", "H3"]);

/** A page: a window, a document over `nodes`, and a log the collector would
 *  have filled. A new page is a new window — which is what a navigation is. */
function page(nodes: FakeEl[], url = "http://127.0.0.1:4000/app") {
  const win: Record<string, unknown> = {
    __agxLog: { console: [] as unknown[], network: [] as unknown[], fakes: [] },
    innerWidth: 1280,
    innerHeight: 800,
  };
  const document = {
    title: "Orbit",
    visibilityState: "visible",
    readyState: "complete",
    cookie: "",
    hasFocus: () => true,
    elementFromPoint: () => null,
    querySelector(sel: string) {
      const e = /data-agx-e="(e[0-9]+)"/.exec(sel)?.[1];
      return nodes.find((n) => n.dataset.agxE === e) ?? null;
    },
    querySelectorAll(sel: string) {
      if (sel === "input,select,textarea") return nodes.filter((n) => ["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName));
      return nodes.filter((n) => PICKED.has(n.tagName) || n.attrs.role || n.attrs["data-testid"]);
    },
  };
  const location = { href: url };
  const getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  const run = (opts: ObserveOpts = {}, since = 0) =>
    new Function(
      "window", "document", "location", "getComputedStyle", "innerWidth", "innerHeight",
      "localStorage", "sessionStorage", "crypto",
      `return ${observeScript(since, 200, opts)}`,
    )(win, document, location, getComputedStyle, 1280, 800, {}, {}, globalThis.crypto) as Record<string, any>;
  return { win, document, nodes, location, run };
}

/** What the relay does between calls: remember the last answer's doc/seq. */
function caller(key = "orbit-agent") {
  let base: { doc: string; seq: number } | null = null;
  return (p: ReturnType<typeof page>, delta = true, since = 0) => {
    const v = p.run({ delta, key, base }, since);
    base = { doc: v.doc, seq: v.seq };
    return v;
  };
}

function signupPage() {
  made = 0;
  return page([
    el("a", "Home"),
    el("a", "Items"),
    el("h1", "Sign up"),
    el("input", "", { attrs: { "aria-label": "Email" }, name: "email", value: "" }),
    el("button", "Create account"),
  ]);
}

describe("observe --delta", () => {
  test("with no earlier look it answers in full and says why", () => {
    const look = caller();
    const v = look(signupPage());
    expect(v.delta).toBe(false);
    expect(v.reason).toContain("no earlier observe");
    expect(v.tree).toHaveLength(5);
    expect(typeof v.doc).toBe("string");
    expect(v.seq).toBe(1);
  });

  test("a plain observe answers exactly as before, plus doc and seq", () => {
    const v = signupPage().run();
    expect(v.delta).toBeUndefined();
    expect(v.reason).toBeUndefined();
    expect(v.tree).toHaveLength(5);
    expect(v.form).toHaveLength(1);
    // The form entry names the same node the tree does.
    expect(v.form[0].e).toBe(v.tree.find((n: { role: string }) => n.role === "input").e);
  });

  test("nothing changed: no nodes, a count, and none of the unchanged sections", () => {
    const p = signupPage();
    const look = caller();
    look(p, false);
    const v = look(p);
    expect(v.delta).toBe(true);
    expect(v.added).toEqual([]);
    expect(v.removed).toEqual([]);
    expect(v.changed).toEqual([]);
    expect(v.same).toBe(5);
    for (const absent of ["tree", "form", "storage", "viewport", "formRemoved"]) expect(v[absent]).toBeUndefined();
    expect(v.base).toBe(1);
    expect(v.seq).toBe(2);
    expect(v.url).toBe("http://127.0.0.1:4000/app");
  });

  test("a client-side route: the nav keeps its ids, the view's new heading is added, the old one removed", () => {
    const p = signupPage();
    const look = caller();
    const first = look(p, false);
    const oldH1 = first.tree.find((n: { role: string }) => n.role === "h1").e;
    const items = first.tree.find((n: { name: string }) => n.name === "Items").e;
    // The router replaces the view's markup: a NEW h1 element, and a banner
    // that pushes everything below it down (which must not count as a change).
    p.nodes.splice(2, 1, el("h1", "Items"), el("div", "Saved", { attrs: { role: "status" } }));
    for (const n of p.nodes.slice(4)) n.rect = { ...n.rect, y: n.rect.y + 40 };
    p.nodes[4]!.disabled = true;
    const v = look(p);
    expect(v.delta).toBe(true);
    expect(v.removed).toEqual([oldH1]);
    expect(v.added.map((n: { role: string; name: string }) => `${n.role}:${n.name}`)).toEqual(["h1:Items", "status:Saved"]);
    expect(v.changed).toEqual([{ e: p.nodes[4]!.dataset.agxE, disabled: true }]);
    // Survivors keep their id — the diff is keyed on it.
    expect(p.nodes[1]!.dataset.agxE).toBe(items);
    expect(v.same).toBe(3);
  });

  test("a node pushed past the tree's cap is unlisted, not removed", () => {
    made = 0;
    const nodes = Array.from({ length: 200 }, (_, i) => el("button", `Edit order ORBIT-${1000 + i}`));
    const p = page(nodes);
    const look = caller();
    look(p, false);
    const last = nodes[199]!.dataset.agxE;
    // Twelve new rows at the top: the last twelve fall off a 200-node list.
    p.nodes.unshift(...Array.from({ length: 12 }, (_, i) => el("button", `Edit order ORBIT-${900 + i}`)));
    const v = look(p);
    expect(v.delta).toBe(true);
    expect(v.removed).toEqual([]);
    expect(v.unlisted).toContain(last);
    expect(v.unlisted).toHaveLength(12);
    // And a node truly gone is still "removed".
    look(p, false);
    const gone = p.nodes.splice(0, 1)[0]!.dataset.agxE;
    expect(look(p).removed).toEqual([gone]);
  });

  test("a field that went away is reported as null, not dropped by JSON", () => {
    const diff = new Function(`return ${OBSERVE_DIFF}`)() as (a: unknown, b: unknown) => any;
    const d = diff(
      { tree: [{ e: "e1", role: "button", name: "Save", disabled: true }], form: [] },
      { tree: [{ e: "e1", role: "button", name: "Save" }], form: [] },
    );
    expect(JSON.parse(JSON.stringify(d.changed))).toEqual([{ e: "e1", disabled: null }]);
  });

  test("typing into a field reports that field's form entry, by id", () => {
    const p = signupPage();
    const look = caller();
    look(p, false);
    p.nodes[3]!.value = "ada@example.test";
    const v = look(p);
    expect(v.delta).toBe(true);
    expect(v.form).toEqual([{ e: p.nodes[3]!.dataset.agxE, name: "email", type: "text", value: "ada@example.test" }]);
    expect(v.changed).toEqual([]);
  });

  test("a navigation is a new document: full answer, delta false, reason", () => {
    const look = caller();
    look(signupPage(), false);
    const v = look(signupPage());
    expect(v.delta).toBe(false);
    expect(v.reason).toBe("new document");
    expect(v.tree).toHaveLength(5);
  });

  test("coming BACK to a page kept in memory is still a full answer — the caller has seen another page since", () => {
    /* A page restored from the back/forward cache is the same window, with
       the store from before the caller left. Diffing against it would
       describe a page the caller last saw two looks ago. */
    const look = caller();
    const a = signupPage();
    look(a, false);
    look(signupPage(), false);
    const v = look(a);
    expect(v.delta).toBe(false);
    expect(v.reason).toBe("new document");
  });

  test("two callers on one tab each diff against their own look", () => {
    const p = signupPage();
    const alice = caller("orbit-a");
    const bob = caller("orbit-b");
    alice(p, false);
    p.nodes[4]!.disabled = true;
    bob(p, false);
    const v = alice(p);
    expect(v.delta).toBe(true);
    // Bob's look in between must not swallow the change Alice has not seen.
    expect(v.changed).toEqual([{ e: p.nodes[4]!.dataset.agxE, disabled: true }]);
  });

  test("a look the relay never recorded breaks the chain: full answer", () => {
    const p = signupPage();
    const v1 = p.run({ key: "k" });
    p.run({ key: "k" }); // answered in the page, lost on the way back
    const v = p.run({ delta: true, key: "k", base: { doc: v1.doc, seq: v1.seq } });
    expect(v.delta).toBe(false);
    expect(v.reason).toContain("not yours");
  });

  test("when most of the page changed, the full answer is the smaller one", () => {
    const p = signupPage();
    const look = caller();
    look(p, false);
    made = 0;
    p.nodes.splice(0, p.nodes.length, el("h1", "Items"), el("a", "Back"), el("button", "Load more"));
    const v = look(p);
    expect(v.delta).toBe(false);
    expect(v.reason).toBe("most of the page changed");
    expect(v.tree).toHaveLength(3);
  });

  test("console and network since that look — including a request that was in flight during it", () => {
    const p = signupPage();
    const look = caller();
    const first = look(p, false);
    const t = first.now as number;
    const log = p.win.__agxLog as { console: unknown[]; network: unknown[] };
    log.console.push({ at: t - 5, level: "log", text: "old" }, { at: t + 5, level: "error", text: "TypeError: new" });
    log.network.push(
      { at: t - 50, method: "GET", url: "/api/old", status: 200, ms: 10 },
      { at: t - 50, method: "GET", url: "/api/slow", status: 500, ms: 400 },
      { at: t + 1, method: "POST", url: "/api/new", status: 422, ms: 5 },
    );
    const v = look(p);
    expect(v.console.map((r: { text: string }) => r.text)).toEqual(["TypeError: new"]);
    expect(v.network.map((r: { url: string }) => r.url)).toEqual(["/api/slow", "/api/new"]);
  });

  test("an id stays on its node across looks, and a node never seen before gets a new one", () => {
    const p = signupPage();
    const a = p.run();
    const b = p.run();
    expect(b.tree.map((n: { e: string }) => n.e)).toEqual(a.tree.map((n: { e: string }) => n.e));
    p.nodes.push(el("button", "Another"));
    const c = p.run();
    expect(c.tree.at(-1).e).not.toBe(c.tree.at(-2).e);
    expect(new Set(c.tree.map((n: { e: string }) => n.e)).size).toBe(c.tree.length);
  });
});

describe("ids stay one node each", () => {
  /* Measured in the app: `cloneNode` copies the data attribute, so a list
     that clones a row it had already shown put the same id on two nodes — the
     tree carried it twice, a delta keyed on it merged them, and a click on it
     was refused as ambiguous. The copy is the node that was never stamped. */
  test("a clone of a stamped node gets its own id; the original keeps its", () => {
    const p = signupPage();
    const first = p.run();
    const button = p.nodes[4]!;
    const id = button.dataset.agxE;
    const clone = el("button", "Create account", { dataset: { ...button.dataset } });
    p.nodes.splice(4, 0, clone); // the copy lands BEFORE the original
    const v = p.run();
    const ids = v.tree.map((n: { e: string }) => n.e);
    expect(new Set(ids).size).toBe(ids.length);
    expect(button.dataset.agxE).toBe(id);
    expect(clone.dataset.agxE).not.toBe(id);
    expect(first.tree.map((n: { e: string }) => n.e)).toContain(id);
  });

  test("markup copied with its attributes (outerHTML into innerHTML) is a new node too", () => {
    const p = signupPage();
    p.run();
    const copied = el("h1", "Sign up", { dataset: { agxE: p.nodes[2]!.dataset.agxE! } });
    p.nodes.push(copied);
    const v = p.run();
    const ids = v.tree.map((n: { e: string }) => n.e);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the driver hands the page what the relay recorded", () => {
  async function sent(args: Record<string, unknown>, op = "observe") {
    const ran: string[] = [];
    const guest = { executeJavaScript: async (code: string) => { ran.push(code); return {}; } };
    await runBrowserAsk(guest as never, { id: "b1", op, args } as never);
    return ran.at(-1)!;
  }

  test("the caller is the key and the relay's base is the baseline", async () => {
    const code = await sent({ delta: true, as: "orbit-a", base: { doc: "k3x9", seq: 4 } });
    // Hashed: the store is on the page's own window, which must not learn who drives it.
    expect(code).toContain(`const key = "${callerKey("orbit-a")}";`);
    expect(code).not.toContain("orbit-a");
    expect(callerKey("orbit-a")).not.toBe(callerKey("orbit-b"));
    expect(code).toContain('const base = {"doc":"k3x9","seq":4};');
    expect(code).toContain("if (!true) return full;");
  });

  test("region stamps with the same rule as observe", async () => {
    // Two copies of the stamp are two answers to "which node is e7".
    expect(await sent({ selector: "main" }, "region")).toContain(STAMP);
    expect(await sent({})).toContain(STAMP);
  });

  test("a malformed base is no base, and no delta flag is a plain observe", async () => {
    const code = await sent({ delta: true, base: { doc: 7, seq: "x" } });
    expect(code).toContain("const base = null;");
    expect(code).toContain('const key = "";');
    expect(await sent({})).toContain("if (!false) return full;");
  });
});
