/*
 * observe and the locators reach into open shadow roots and same-origin
 * frames. The page scripts are the real strings the driver hands to
 * executeJavaScript, run against the stand-in page in standinDom.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runBrowserAsk, setFindWaitMs } from "../src/lib/browserDrive.ts";
import { observeScript } from "../src/lib/browserObserve.ts";
import { Root, h, page } from "./standinDom.ts";

const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

beforeAll(() => setFindWaitMs(0));
afterAll(() => setFindWaitMs());

/** A checkout page: one button in a web component's open shadow root, a card
 *  form in a same-origin frame, and a frame from another origin. */
function checkout() {
  const pay = h("button", {}, "Pay now");
  const host = h("pay-widget");
  host.shadowRoot = new Root("shadow", h("div", {}, pay));
  const card = h("input", { type: "text", "aria-label": "Card number" });
  const frame = h("iframe", { name: "card" });
  frame.frameDoc = new Root("frame", h("body", {}, card));
  const foreign = h("iframe", { name: "ads" });
  foreign.crossOrigin = true;
  const body = h("body", {}, h("button", {}, "Cancel"), host, frame, foreign);
  return { pay, card, ...page(body) };
}

const look = async (p: ReturnType<typeof checkout>) =>
  await p.guest.executeJavaScript(observeScript(0, 200, {})) as { tree: Array<Record<string, unknown>>; form: Array<Record<string, unknown>> };

describe("observe into shadow roots and frames", () => {
  test("lists a shadow button and a frame input, marked, and skips a cross-origin frame", async () => {
    const v = await look(checkout());
    const pay = v.tree.find((n) => n.name === "Pay now");
    expect(pay).not.toBeUndefined();
    expect(pay!.in).toBe("shadow");
    const card = v.tree.find((n) => n.name === "Card number");
    expect(card).not.toBeUndefined();
    expect(card!.in).toBe("frame");
    expect(card!.frame).toBe("card");
    // The light-DOM button carries no mark.
    expect(v.tree.find((n) => n.name === "Cancel")!.in).toBeUndefined();
    // The frame's input is a form field too, with the id the tree gave it.
    expect(v.form.map((f) => f.e)).toContain(card!.e);
    // Every id is unique across the three roots.
    expect(new Set(v.tree.map((n) => n.e)).size).toBe(v.tree.length);
  });
});

describe("acting on an id from inside", () => {
  test("click e-id reaches a button inside an open shadow root", async () => {
    const p = checkout();
    const v = await look(p);
    const id = v.tree.find((n) => n.name === "Pay now")!.e as string;
    const r = await runBrowserAsk(p.guest, ask("click", { selector: id }));
    expect(r.ok).toBe(true);
    expect(p.pay.events).toContain("click");
  });

  test("a role locator finds the shadow button without an observe", async () => {
    const p = checkout();
    const r = await runBrowserAsk(p.guest, ask("click", { selector: 'role=button[name="Pay now"]' }));
    expect(r.ok).toBe(true);
    expect(p.pay.events).toContain("click");
  });

  test("fill by id writes into an input in a same-origin frame", async () => {
    const p = checkout();
    const v = await look(p);
    const id = v.tree.find((n) => n.name === "Card number")!.e as string;
    const r = await runBrowserAsk(p.guest, ask("fill", { fields: { [id]: "4242" } }));
    expect(r.ok).toBe(true);
    expect(p.card.value).toBe("4242");
  });

  test("a frame field is written with the frame's own setter, not the top window's", async () => {
    /* The top window's native setter called on another window's field throws
       "Illegal invocation"; the setter taken from the field's own window works. */
    const p = checkout();
    const frameView = p.card.ownerDocument!.defaultView as { HTMLInputElement: { prototype: object } };
    const wrote: string[] = [];
    Object.defineProperty(frameView.HTMLInputElement.prototype, "value", { set(v: string) { wrote.push(v); }, configurable: true });
    const r = await runBrowserAsk(p.guest, ask("fill", { fields: { "label=Card number": "4242" } }));
    expect(r.ok).toBe(true);
    expect(wrote).toEqual(["4242"]);
  });

  test("a locator reaches the frame input too", async () => {
    const p = checkout();
    const r = await runBrowserAsk(p.guest, ask("fill", { fields: { "label=Card number": "4242" } }));
    expect(r.ok).toBe(true);
    expect(p.card.value).toBe("4242");
  });

  test("a cross-origin frame is skipped, not an error", async () => {
    const p = checkout();
    const r = await runBrowserAsk(p.guest, ask("click", { selector: 'role=button[name="Nowhere"]' }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toContain("cross-origin");
  });

  test("an id that no observe minted is still refused as foreign", async () => {
    const p = checkout();
    await look(p);
    const r = await runBrowserAsk(p.guest, ask("click", { selector: "e9999" }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("observe");
  });
});

