/*
 * `shot --marks` draws an `eN` label on every interactive thing that is on
 * screen and visible, using the id observe gives the same node. There is no
 * renderer in this project, so the script runs against a hand-made document:
 * enough of one to ask "which of these gets a label".
 */
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { MARKS_ID, MARKS_SCRIPT } from "../src/lib/browserDrive.ts";

type Box = { x: number; y: number; width: number; height: number };
function node(name: string, box: Box, style: Partial<{ display: string; visibility: string; opacity: string }> = {}) {
  const el: any = {
    name, dataset: {}, style: {}, children: [] as any[], parentNode: null,
    getBoundingClientRect: () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }),
    cs: { display: "block", visibility: "visible", opacity: "1", ...style },
    contains: (o: any) => o === el,
    appendChild(c: any) { c.parentNode = el; el.children.push(c); return c; },
    remove() { const p = el.parentNode; if (p) p.children.splice(p.children.indexOf(el), 1); },
  };
  return el;
}

function run(items: any[], covering: (x: number, y: number) => any = () => null) {
  const body = node("body", { x: 0, y: 0, width: 800, height: 600 });
  const ctx: any = {
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, WeakSet, Math, Number,
    getComputedStyle: (e: any) => e.cs,
    document: {
      body,
      createElement: () => node("made", { x: 0, y: 0, width: 0, height: 0 }),
      querySelectorAll: () => items,
      elementFromPoint: (x: number, y: number) => covering(x, y) ?? items.find((i) => {
        const r = i.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) ?? null,
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const ids = vm.runInContext(MARKS_SCRIPT, ctx) as string[];
  return { ids, body, ctx };
}

describe("shot --marks", () => {
  test("labels what is on screen, with observe's ids, and nothing else", () => {
    const save = node("save", { x: 10, y: 10, width: 80, height: 30 });
    const hidden = node("hidden", { x: 10, y: 60, width: 80, height: 30 }, { display: "none" });
    const invisible = node("invisible", { x: 10, y: 100, width: 80, height: 30 }, { opacity: "0" });
    const below = node("below", { x: 10, y: 900, width: 80, height: 30 });
    const empty = node("empty", { x: 10, y: 150, width: 0, height: 0 });
    const { ids, body } = run([save, hidden, invisible, below, empty]);
    expect(ids).toEqual(["e1"]);
    expect(save.dataset.agxE).toBe("e1");
    const root = body.children[0];
    expect(root.children).toHaveLength(1);
    expect(root.children[0].children[0].textContent).toBe("e1");
  });

  test("a control another element covers is not labelled", () => {
    const covered = node("covered", { x: 10, y: 10, width: 80, height: 30 });
    const modal = node("modal", { x: 0, y: 0, width: 800, height: 600 });
    const { ids } = run([covered], () => modal);
    expect(ids).toEqual([]);
  });

  test("the overlay is one element with a fixed id, so one removal takes it all down", () => {
    const { body } = run([node("a", { x: 0, y: 0, width: 10, height: 10 })]);
    expect(MARKS_ID).toBe("__agx_shot_marks__");
    expect(body.children).toHaveLength(1);
  });

  test("at most a hundred labels", () => {
    const many = Array.from({ length: 150 }, (_, i) => node(`n${i}`, { x: (i % 40) * 20, y: Math.floor(i / 40) * 20, width: 18, height: 18 }));
    expect(run(many).ids).toHaveLength(100);
  });
});
