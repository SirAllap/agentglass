/**
 * `click` must be a whole press, not a lone `click` event: an app that
 * listens for pointerdown or mousedown (a chat list, a menu that opens on
 * press) answered "ok" and did nothing when only `el.click()` ran.
 *
 * The generated script is run for real against a fake element that records
 * every event it receives, so the order is asserted on what arrives, not on
 * the shape of the source.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk } from "../src/lib/browserDrive.ts";
import { h, page } from "./standinDom";

const ask = (op: string, args: Record<string, unknown> = {}) => ({ id: "b1", op, args }) as never;

async function press(opts: { cancel?: string } = {}) {
  const btn = h("button", { id: "row" }, "Open");
  const { guest } = page(h("body", {}, btn));
  const seen: { type: string; x: number; y: number; buttons: number }[] = [];
  btn.dispatchEvent = (ev: any) => {
    btn.events.push(ev.type);
    seen.push({ type: ev.type, x: ev.clientX, y: ev.clientY, buttons: ev.buttons });
    return ev.type !== opts.cancel;
  };
  const r: any = await runBrowserAsk(guest, ask("click", { selector: "#row" }));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { seen, rect: btn.getBoundingClientRect(), focused: btn.events.filter((e) => e === "focus").length };
}

describe("click is a whole press, not a lone click event", () => {
  test("the events a mouse makes arrive in the order a mouse makes them, at the centre", async () => {
    const { seen, rect, focused } = await press();
    expect(seen.map((s) => s.type)).toEqual([
      "pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove",
      "pointerdown", "mousedown", "pointerup", "mouseup", "click",
    ]);
    expect(seen.every((s) => s.x === rect.left + rect.width / 2 && s.y === rect.top + rect.height / 2)).toBe(true);
    expect(seen.find((s) => s.type === "mousedown")!.buttons).toBe(1);
    expect(seen.find((s) => s.type === "mouseup")!.buttons).toBe(0);
    expect(focused).toBe(1);
  });

  test("an element that listens only to mousedown sees exactly one, and one click follows", async () => {
    const { seen } = await press();
    expect(seen.filter((s) => s.type === "mousedown")).toHaveLength(1);
    expect(seen.filter((s) => s.type === "click")).toHaveLength(1);
  });

  test("a cancelled pointerdown suppresses the mouse events but not the click", async () => {
    const { seen, focused } = await press({ cancel: "pointerdown" });
    const types = seen.map((s) => s.type);
    expect(types).not.toContain("mousedown");
    expect(types).not.toContain("mouseup");
    expect(types).toContain("click");
    expect(focused).toBe(0);
  });

  test("a cancelled mousedown keeps the focus where it was", async () => {
    const { seen, focused } = await press({ cancel: "mousedown" });
    expect(seen.map((s) => s.type)).toContain("click");
    expect(focused).toBe(0);
  });
});
