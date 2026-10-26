/*
 * A hidden pane paints for the length of a screenshot, and not a moment longer.
 *
 * And every hidden thing BETWEEN the guest and the pane with it. A pane held one
 * guest when this was written; it holds one per tab now, and a tab that is not
 * the active one carries its own `visibility: hidden`. Lighting only the view
 * left a background tab dark, so its guest never composited and every capture
 * route failed — measured on a real app, four steps on one tab: in front,
 * 0.648s and a file; in the background, 19.70s and nothing; brought BACK to the
 * front, 19.86s and nothing.
 *
 * This is the fix for the failure that took three builds to name: the workspace
 * hides inactive views with `visibility: hidden`, Chromium passes that on to the
 * guest, and a page told to stop painting has no frame for anybody to copy —
 * every capture route failed, on every page, for as long as the browser was not
 * the view on screen.
 *
 * What must hold: the pane is visible while the capture runs, it is INVISIBLE
 * anyway (opacity 0, no pointer events — nothing appears, no click changes
 * target), and it goes back to hidden even when the capture throws.
 */
import { describe, expect, test } from "bun:test";
import { paintOnDemand, paneOf, whilePainting } from "../src/lib/panePainting.ts";
import { readFileSync } from "node:fs";

type Style = { visibility: string; opacity: string; pointerEvents: string };
function fakePane(visibility = "hidden") {
  const style: Style = { visibility, opacity: "", pointerEvents: "" };
  const pane = { style, tagName: "DIV" } as unknown as HTMLElement;
  const guest = { closest: (sel: string) => (sel === "[data-agx-viewbox]" ? pane : null) } as unknown as Element;
  return { pane, guest, style };
}

/** A guest inside a hidden TAB wrapper, inside the pane — the shape the panel
 *  actually builds, and the one that was left dark. */
function fakeTabInPane(paneVisibility = "hidden", tabVisibility = "hidden") {
  const paneStyle: Style = { visibility: paneVisibility, opacity: "", pointerEvents: "" };
  const tabStyle: Style = { visibility: tabVisibility, opacity: "", pointerEvents: "" };
  const pane = { style: paneStyle, tagName: "DIV", parentElement: null } as unknown as HTMLElement;
  const tab = { style: tabStyle, tagName: "DIV", parentElement: pane } as unknown as HTMLElement;
  const guest = {
    style: { visibility: "", opacity: "", pointerEvents: "" },
    parentElement: tab,
    closest: (sel: string) => (sel === "[data-agx-viewbox]" ? pane : null),
  } as unknown as Element;
  return { pane, tab, guest, paneStyle, tabStyle };
}
const now = { wait: async () => {} };

describe("painting a hidden pane", () => {
  test("visible while it runs, hidden again after", async () => {
    const { guest, style } = fakePane();
    const seen: Style[] = [];
    const out = await whilePainting(guest, async () => { seen.push({ ...style }); return "png"; }, now);
    expect(out).toBe("png");
    expect(seen[0]!.visibility).toBe("visible");
    // And invisible while visible, which is the whole point: an agent's
    // screenshot must not take the screen off the person.
    expect(seen[0]!.opacity).toBe("0");
    expect(seen[0]!.pointerEvents).toBe("none");
    expect(style.visibility).toBe("hidden");
    expect(style.opacity).toBe("");
    expect(style.pointerEvents).toBe("");
  });

  test("hidden again even when the capture throws", async () => {
    const { guest, style } = fakePane();
    await expect(whilePainting(guest, async () => { throw new Error("UnknownVizError"); }, now)).rejects.toThrow("UnknownVizError");
    expect(style.visibility).toBe("hidden");
  });

  /* A pane already on screen must not be touched at all: the person is looking
     at it, and 300ms of warm-up buys nothing. */
  test("a visible pane is left alone", async () => {
    const { guest, style } = fakePane("visible");
    let ran = false;
    await whilePainting(guest, async () => { ran = true; return 1; }, { wait: async () => { throw new Error("should not warm up"); } });
    expect(ran).toBe(true);
    expect(style.opacity).toBe("");
  });

  test("a guest outside the workspace's panes runs as it is", async () => {
    const loose = { closest: () => null } as unknown as Element;
    expect(paneOf(loose)).toBeNull();
    expect(await whilePainting(loose, async () => "ok", now)).toBe("ok");
    expect(await whilePainting(null, async () => "ok", now)).toBe("ok");
  });
});

describe("a guest inside a hidden TAB", () => {
  test("the tab is lit too, not only the pane", async () => {
    const { guest, paneStyle, tabStyle } = fakeTabInPane();
    const seen: { pane: string; tab: string }[] = [];
    await whilePainting(guest, async () => {
      seen.push({ pane: paneStyle.visibility, tab: tabStyle.visibility });
      return "png";
    }, now);
    expect(seen[0], "both, or the guest never composites").toEqual({ pane: "visible", tab: "visible" });
    expect(paneStyle.visibility, "and both put back").toBe("hidden");
    expect(tabStyle.visibility).toBe("hidden");
  });

  test("a visible pane with a hidden tab still lights the tab", async () => {
    /* The case that was invisible: he is LOOKING at the browser view, so the
       pane is on screen, and the tab he is not looking at is dark. Nothing in
       the old code touched it. */
    const { guest, paneStyle, tabStyle } = fakeTabInPane("visible", "hidden");
    const seen: string[] = [];
    await whilePainting(guest, async () => { seen.push(tabStyle.visibility); return "png"; }, now);
    expect(seen[0]).toBe("visible");
    expect(tabStyle.visibility).toBe("hidden");
    expect(paneStyle.visibility, "and a pane that was already visible is left alone").toBe("visible");
  });

  test("nothing hidden anywhere is still a no-op", async () => {
    const { guest, paneStyle, tabStyle } = fakeTabInPane("visible", "visible");
    await whilePainting(guest, async () => "png", now);
    expect(paneStyle.opacity, "no warm-up, no restore, nothing touched").toBe("");
    expect(tabStyle.opacity).toBe("");
  });
});

/*
 * Trusted input is dropped by a pane that is not painting — measured on an
 * isolated build with the terminal in front: `click` and `type` were sent,
 * the page logged no event at all, and the answer still said `clicked`. So an
 * acting verb lights the pane on its first send and keeps it lit until it has
 * answered, when the page has confirmed what arrived.
 */
describe("a verb that sends input lights the pane first", () => {
  test("lit from the first send until release, once", async () => {
    const { guest, paneStyle, tabStyle } = fakeTabInPane();
    let waits = 0;
    const lit = paintOnDemand(guest, { wait: async () => { waits++; } });
    expect(paneStyle.visibility, "nothing is lit before anything is sent").toBe("hidden");
    const seen: string[] = [];
    for (const n of [1, 2]) await lit.run(async () => { seen.push(`${n}:${paneStyle.visibility}/${tabStyle.visibility}/${tabStyle.opacity}`); });
    expect(seen).toEqual(["1:visible/visible/0", "2:visible/visible/0"]);
    expect(waits, "one warm-up per verb, not per key").toBe(1);
    expect(tabStyle.pointerEvents).toBe("none");
    await lit.release();
    expect(paneStyle.visibility).toBe("hidden");
    expect(tabStyle.visibility).toBe("hidden");
    expect(tabStyle.opacity).toBe("");
  });

  test("a verb that never sends pays nothing and touches nothing", async () => {
    const { guest, paneStyle } = fakeTabInPane();
    let waits = 0;
    const lit = paintOnDemand(guest, { wait: async () => { waits++; } });
    await lit.release();
    expect(waits).toBe(0);
    expect(paneStyle.visibility).toBe("hidden");
    expect(paneStyle.opacity).toBe("");
  });

  test("a style somebody else changed while lit is not written over", async () => {
    /* A tab an agent starts driving is restyled by React mid-verb: its own
       `visibility` goes. Putting "hidden" back over that left it dark after it
       came to the front. */
    const { guest, tabStyle } = fakeTabInPane("visible", "hidden");
    const lit = paintOnDemand(guest, now);
    await lit.run(async () => { tabStyle.visibility = ""; });
    await lit.release();
    expect(tabStyle.visibility).toBe("");
  });

  test("two verbs on two tabs share the pane: the first to answer does not put it out", async () => {
    const pane = { style: { visibility: "hidden", opacity: "", pointerEvents: "" }, parentElement: null } as unknown as HTMLElement;
    const guestIn = () => ({ style: { visibility: "", opacity: "", pointerEvents: "" }, parentElement: pane,
      closest: (sel: string) => (sel === "[data-agx-viewbox]" ? pane : null) }) as unknown as Element;
    const a = paintOnDemand(guestIn(), now), b = paintOnDemand(guestIn(), now);
    await a.run(async () => {});
    await b.run(async () => {});
    await a.release();
    expect(pane.style.visibility, "b is still sending").toBe("visible");
    await b.release();
    expect(pane.style.visibility).toBe("hidden");
    expect(pane.style.opacity).toBe("");
  });

  test("the bus sends every trusted input through it, and releases after the answer", () => {
    const src = readFileSync(new URL("../src/lib/browserBus.ts", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    expect(src).toContain("return lit.run(() => browserInput(req, guest));");
    expect(src).not.toMatch(/return browserInput\(req, guest\)/);
    expect(src).toContain(".finally(lit.release)");
  });
});
