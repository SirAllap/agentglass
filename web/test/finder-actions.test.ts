import { describe, expect, test } from "bun:test";
import { actionGroup, actionMenuLabel, blankAction, confirmWords, fromForm, listText, slugify, whenSummary } from "../src/lib/finderActions.ts";
import type { FinderAction } from "../../shared/types.ts";

const act = (o: Partial<FinderAction> & { id: string; name: string }): FinderAction => ({ ...blankAction(), ...o });

describe("the actions in the context menu", () => {
  test("nothing matching adds no group; a submenu action goes under one entry, a top action stands in the menu", () => {
    expect(actionGroup([])).toBeNull();
    const g = actionGroup([act({ id: "a", name: "Resize" }), act({ id: "b", name: "Hash", menu: "top" })])!;
    expect(g.map((i) => i.label)).toEqual(["Hash", "Actions"]);
    expect(g[1]!.sub!.map((i) => i.action)).toEqual(["a"]);
    expect(g[0]!.action).toBe("b");
  });
  test("only submenu actions: just the Actions entry", () => {
    expect(actionGroup([act({ id: "a", name: "Resize" })])!.map((i) => i.label)).toEqual(["Actions"]);
  });
  test("an action that cannot run is drawn but disabled, with the reason", () => {
    const g = actionGroup([act({ id: "a", name: "Resize", unavailable: "python3 was not found" })])!;
    expect(g[0]!.sub![0]!.disabled).toBe(true);
    expect(actionMenuLabel(act({ id: "a", name: "Resize", unavailable: "python3 was not found" }))).toContain("python3 was not found");
  });
  test("confirm words name the action and the count", () => {
    expect(confirmWords(act({ id: "a", name: "Resize" }), 3).title).toBe("Run Resize on 3 items?");
    expect(confirmWords(act({ id: "a", name: "Resize" }), 1).title).toBe("Run Resize on 1 item?");
  });
});

describe("the editor's form", () => {
  test("a name becomes a safe id", () => {
    expect(slugify("Resize to 800 px!")).toBe("resize-to-800-px");
    expect(slugify("  ")).toBe("");
    expect(slugify("--Hash  it--")).toBe("hash-it");
  });
  test("a list is split on commas and lines, lowercased, dots dropped", () => {
    expect(listText.parse(" .PNG, jpg\nwebp ,, ")).toEqual(["png", "jpg", "webp"]);
    expect(listText.show(["png", "jpg"])).toBe("png, jpg");
  });
  test("the form becomes the manifest the server judges; a python action keeps its entrypoint, a command its program", () => {
    const m = fromForm({ ...blankAction(), id: "", name: "Resize" }, { id: "", kinds: "file", extensions: "png, jpg", mime: "", maxItems: "" });
    expect(m.id).toBe("resize");
    expect(m.when.kinds).toEqual(["file"]);
    expect(m.when.extensions).toEqual(["png", "jpg"]);
    expect(m.when.max_items).toBeNull();
    const c = fromForm({ ...blankAction(), name: "Hash", run: { ...blankAction().run, runtime: "command", program: "sha256sum", args: ["--"] } }, { id: "", kinds: "both", extensions: "", mime: "", maxItems: "2" });
    expect(c.when.kinds).toEqual([]);
    expect(c.when.max_items).toBe(2);
  });
  test("when summary reads in plain words", () => {
    expect(whenSummary(act({ id: "a", name: "x", when: { kinds: ["file"], extensions: ["png"], mime_types: [], min_items: 1, max_items: null } }))).toBe("Files · .png");
    expect(whenSummary(act({ id: "a", name: "x" }))).toBe("Any file or folder");
  });
});

import { withActions, menuFor } from "../src/lib/finderOps.ts";
const ctx = { count: 1, canPaste: false, hidden: false, previewable: true };
describe("where the group sits", () => {
  const g = actionGroup([act({ id: "a", name: "Resize" })]);
  test("before Cut in a file menu, after Open With in the empty-space one, absent when none match", () => {
    const f = withActions(menuFor("file", ctx), g);
    const at = f.findIndex((x) => x.some((i) => i.id === "actions"));
    expect(f[at + 1]!.some((i) => i.id === "cut")).toBe(true);
    const e = withActions(menuFor("empty", ctx), g);
    expect(e[1]!.some((i) => i.id === "open-with")).toBe(true);
    expect(e[2]!.some((i) => i.id === "actions")).toBe(true);
    expect(withActions(menuFor("file", ctx), null)).toEqual(menuFor("file", ctx));
  });
});

describe("the wiring, read as source", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/useFinderOps.tsx", import.meta.url)).text();
  test("an action that asks for a yes is confirmed before it is run, and the match is given up on after 400 ms", async () => {
    const t = await src;
    const fn = t.slice(t.indexOf("const startAction = useCallback("), t.indexOf("const startName"));
    expect(fn.indexOf("a.run.confirm && !confirmed")).toBeGreaterThan(-1);
    expect(fn.indexOf("a.run.confirm && !confirmed")).toBeLessThan(fn.indexOf("api.actionRun("));
    expect(t).toContain("setTimeout(() => res(null), 400)");
  });
});

import { subPlace } from "../src/components/finder/machine/FinderOpsUI.tsx";
describe("where the submenu opens", () => {
  const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b }) as DOMRect;
  const win = (w: number, h: number) => { (globalThis as { window?: unknown }).window = { innerWidth: w, innerHeight: h }; };
  test("to the right when there is room, to the left when not, below its entry when neither fits", () => {
    win(1400, 900);
    expect(subPlace(rect(300, 420, 610, 448), 260, 40).left).toBe(614);
    win(900, 900);
    expect(subPlace(rect(700, 420, 880, 448), 260, 40).left).toBe(436);
    win(500, 900);
    const p = subPlace(rect(183, 420, 491, 448), 260, 40);
    expect(p.top).toBeGreaterThanOrEqual(448);
    delete (globalThis as { window?: unknown }).window;
  });
});
