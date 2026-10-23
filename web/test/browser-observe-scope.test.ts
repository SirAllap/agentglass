/*
 * observe --viewport / --root, and the smaller tree: the real observe script
 * run against the stand-in page in standinDom.ts.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk } from "../src/lib/browserDrive.ts";
import { observeScript, type ObserveOpts } from "../src/lib/browserObserve.ts";
import { h, page } from "./standinDom.ts";

type Entry = Record<string, unknown>;
type Seen = {
  tree: Entry[]; form: Entry[]; outOfView?: number; wrappers?: number; doc?: string; seq?: number;
  delta?: boolean; reason?: string; __agxRoot?: string; [k: string]: unknown;
};

const run = async (p: ReturnType<typeof page>, opts: ObserveOpts = {}) =>
  await p.guest.executeJavaScript(observeScript(0, 200, opts)) as Seen;
const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

/** A toolbar the way component libraries build one: icon buttons each inside
 *  three layers of unnamed layout wrappers, plus spacers. */
function toolbar() {
  const icon = (label: string) => h("div", { role: "presentation" },
    h("div", { role: "none" }, h("div", { role: "generic" }, h("button", { "aria-label": label }))));
  const body = h("body", {},
    h("div", { role: "presentation" }, icon("Menu"), icon("Search"), icon("Share"), icon("Settings"),
      h("span", { role: "presentation" }), h("span", { role: "none" })),
    h("h1", {}, "Orbit"),
    h("button", {}, "Save"));
  return page(body);
}

/** What the same fixture weighed before the tree was compacted, measured on
 *  the unchanged script: 21 entries, each with an empty name. */
const BEFORE = { tree: 1268, whole: 1570, entries: 21 };

describe("the tree stays small", () => {
  test("unnamed layout wrappers are left out, counted, and the buttons inside stay", async () => {
    const v = await run(toolbar());
    const bytes = JSON.stringify(v.tree).length;
    const whole = JSON.stringify(v).length;
    console.log(`observe JSON bytes on the toolbar fixture: tree ${BEFORE.tree} -> ${bytes}, whole ${BEFORE.whole} -> ${whole}`);
    expect(bytes).toBeLessThan(BEFORE.tree);
    expect(whole).toBeLessThan(BEFORE.whole);
    expect(v.tree.map((n) => n.name).filter(Boolean)).toEqual(["Menu", "Search", "Share", "Settings", "Orbit", "Save"]);
    expect(v.tree).toHaveLength(6);
    expect(v.wrappers).toBe(BEFORE.entries - 6);
  });

  test("an empty name is not written, and a wrapper with a hook of its own stays", async () => {
    const body = h("body", {},
      h("div", { role: "presentation", "data-testid": "toolbar" }),
      h("div", { role: "presentation", id: "gap" }),
      h("div", { role: "group", "aria-label": "Tools" }),
      h("div", { role: "status" }));
    const v = await run(page(body));
    expect(v.tree.map((n) => n.testid ?? n.id ?? n.name ?? n.role)).toEqual(["toolbar", "gap", "Tools", "status"]);
    for (const n of v.tree) expect("name" in n && n.name === "").toBe(false);
    expect(v.wrappers).toBeUndefined();
  });
});

/** Three buttons: one in view, one below the fold, one off to the left. */
function fold() {
  const a = h("button", {}, "In view");
  const b = h("button", {}, "Below");
  const c = h("button", {}, "Left");
  b.pos = { x: 10, y: 900 };
  c.pos = { x: -300, y: 10 };
  const gone = h("button", { style: "display:none" }, "Hidden");
  gone.style = { display: "none" };
  return page(h("body", {}, a, b, c, gone));
}

describe("observe --viewport", () => {
  test("the form list is the viewport's too", async () => {
    const near = h("input", { type: "text", "aria-label": "Email" });
    const far = h("input", { type: "text", "aria-label": "Notes" });
    far.pos = { x: 10, y: 2000 };
    const q = page(h("body", {}, near, far));
    expect((await run(q, { viewport: true })).form.map((f) => f.name)).toEqual(["Email"]);
    expect((await run(q)).form).toHaveLength(2);
  });

  test("lists only what intersects the viewport and counts the rest", async () => {
    const v = await run(fold(), { viewport: true });
    expect(v.tree.map((n) => n.name)).toEqual(["In view"]);
    expect(v.outOfView).toBe(3);
  });

  test("a plain observe lists everything and carries no count", async () => {
    const v = await run(fold());
    expect(v.tree).toHaveLength(4);
    expect(v.outOfView).toBeUndefined();
  });

  test("a node partly inside the viewport counts as inside", async () => {
    const edge = h("button", {}, "Edge");
    edge.pos = { x: 1250, y: 780 };
    edge.box = { width: 100, height: 100 };
    const q = page(h("body", {}, edge));
    expect((await run(q, { viewport: true })).tree).toHaveLength(1);
  });
});

/** A page with two panels, so a root is a subtree and not the page. */
function panels() {
  const save = h("button", {}, "Save");
  const left = h("div", { role: "region", "aria-label": "Left" }, h("a", { href: "/a" }, "One"), save);
  const right = h("div", { role: "region", "aria-label": "Right" }, h("a", { href: "/b" }, "Two"));
  return { save, left, ...page(h("body", {}, left, right, h("a", { href: "/c" }, "Outside"))) };
}

describe("observe --root", () => {
  test("lists the subtree of that element, the element itself included", async () => {
    const p = panels();
    const all = await run(p);
    const leftId = all.tree.find((n) => n.name === "Left")!.e as string;
    const v = await run(p, { root: leftId });
    expect(v.tree.map((n) => n.e)).toContain(leftId);
    const names = v.tree.map((n) => n.name);
    expect(names).toContain("One");
    expect(names).toContain("Save");
    expect(names).not.toContain("Two");
    expect(names).not.toContain("Outside");
  });

  test("an id the page dropped is refused, unobserved and foreign ids too", async () => {
    const p = panels();
    expect((await run(p, { root: "e5" })).__agxRoot).toBe("unobserved");
    const all = await run(p);
    expect((await run(p, { root: "e9999" })).__agxRoot).toBe("foreign");
    const id = all.tree[0]!.e as string;
    p.doc.querySelector(`[data-agx-e="${id}"]`)!.attrs["data-agx-e"] = "";
    expect((await run(p, { root: id })).__agxRoot).toBe("gone");
  });

  test("the driver turns a refusal into a sentence that says what to do", async () => {
    const p = panels();
    await run(p);
    const r = await runBrowserAsk(p.guest, ask("observe", { root: "e9999" }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("Observe this tab again");
  });
});

describe("a scoped observe leaves the delta baseline alone", () => {
  test("a full look, a scoped look, then a delta still diffs against the full one", async () => {
    const p = panels();
    const first = await run(p, { key: "agent" });
    const base = { doc: first.doc!, seq: first.seq! };
    const scoped = await run(p, { key: "agent", viewport: true });
    // The relay records doc and seq from the answer it hands over; a scoped
    // answer carries neither, so the caller's baseline stays the full look.
    expect(scoped.doc).toBeUndefined();
    expect(scoped.seq).toBeUndefined();
    const d = await run(p, { key: "agent", delta: true, base });
    expect(d.delta).toBe(true);
    expect(d.same).toBe(first.tree.length);
  });
});
