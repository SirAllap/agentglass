/*
 * The browser panel, actually rendered.
 *
 * Written because the redesign shipped without it and everything the person
 * using it tried was broken: the address box opened empty, Ctrl+T worked
 * "sometimes", the bar would not hide, and there was no way at all to make a
 * folder. Not one of those needs a running Chromium to catch — they are all
 * visible in the first paint, or in the plain rules the paint reads from.
 *
 * There is no DOM under `bun test`, so effects never run. What these see is the
 * first frame: the shape somebody is looking at before anything loads, which is
 * exactly where a whole section drawn only "once you have dragged something
 * into it" hides.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* The panel asks the shell whether there is a browser at all and returns null
   when there is not — so the bridge has to exist BEFORE the module is imported,
   which is why this is a dynamic import below. */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;
(globalThis as unknown as { window: unknown }).window = {
  agentglass: { desktop: true, browser: true, browserPartition: "persist:agentglass-browser" },
  localStorage: (globalThis as unknown as { localStorage: Storage }).localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  location: { origin: "http://localhost:4000", href: "http://localhost:4000/", protocol: "http:", host: "localhost:4000" },
};
(globalThis as unknown as { location: unknown }).location = (globalThis as unknown as { window: { location: unknown } }).window.location;
/* Modules further down the graph register listeners at import time — the chat
   store persists on `visibilitychange`. Enough of a document for that, and no
   more: this suite renders to a string and never touches one. */
(globalThis as unknown as { document: unknown }).document = {
  addEventListener() {}, removeEventListener() {},
  visibilityState: "visible",
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} }, body: { appendChild() {} },
};

const draw = async (): Promise<string> => {
  const mod = await import("../src/components/BrowserPanel.tsx");
  /* `HAS_BROWSER` is a module constant read from the bridge at import time, and
     by the time this file runs, another suite in the same process has usually
     imported desktop.ts already — with no bridge, so the constant is false and
     the panel renders nothing. The seam is how a test gets past a fact that is
     decided before it can speak. */
  mod.__forceBrowser(true);
  return renderToStaticMarkup(React.createElement(mod.BrowserView, { active: true }));
};

const seedSession = (url: string, title: string) => {
  store.set("agentglass.browser.session", JSON.stringify({
    v: 2, current: "", byProfile: { "": { tabs: [{ url, title, icon: null }], active: 0 } },
  }));
};

beforeEach(() => {
  store.clear();
  // Cache-busting the import between cases would re-register React's dispatcher
  // for nothing: the panel reads storage in its state initialisers, so a fresh
  // render is enough.
  store.set("__t", String(Math.random()));
});

describe("the bar draws what it is for", () => {
  test("the panel is not empty on its first paint", async () => {
    expect((await draw()).length).toBeGreaterThan(400);
  });

  test("the address of the page you are on is IN the bar, not only in the box", async () => {
    seedSession("https://orbit.example/agent/to-do-list", "Orbit");
    const html = await draw();
    // The chip is the thing he pointed at: it has to carry the address before
    // anything is clicked.
    expect(html).toContain("orbit.example/agent/to-do-list");
  });

  test("a page with no address says so instead of drawing an empty chip", async () => {
    // A blank home page is a real setting — "open nothing" — and it is the one
    // state where the chip has no address to draw.
    store.set("agentglass.browser.home", "about:blank");
    expect(await draw()).toContain("Type an address");
  });

  /*
   * The empty shortcuts grid went, and this is the third decision about that
   * strip, so the history is worth keeping straight: it was invisible until it
   * held something, then it was made always-visible so the gesture could be
   * found, and now it is back to holding-something-or-being-dragged-onto.
   *
   * What changed is what the bar is for. A browser one person used had room to
   * teach a gesture; a bar showing ten agents' folders does not — those 40px
   * were a sentence about dragging, above the pages you came to see. The drop
   * target still appears the instant a drag starts, which is when the sentence
   * is worth reading.
   */
  test("the shortcuts grid stays out of the bar until it holds something", async () => {
    const html = await draw();
    expect(html).not.toContain("keep it in every space");
    expect(html).not.toContain("SHORTCUTS");
  });

  test("so is the way to make a folder", async () => {
    expect(await draw()).toContain("New folder");
  });

  test("and the way to open a tab", async () => {
    expect(await draw()).toContain("New tab");
  });

  test("what is kept is drawn, with its folder", async () => {
    store.set("agentglass.browser.shelf", JSON.stringify({
      "": {
        essentials: [{ id: "e1", url: "https://acme.example/dashboard", title: "Acme", icon: null }],
        loose: [],
        folders: [{ id: "f1", name: "Orbit", open: true, items: [{ id: "s1", url: "https://orbit.example/one", title: "Ticket one" }], folders: [] }],
      },
    }));
    const html = await draw();
    expect(html).toContain("Orbit");
    expect(html).toContain("Ticket one");
    // The count beside a folder, which is what a folded one is read by.
    expect(html).toContain("acme.example/dashboard");
  });

  /*
   * The spaces ARE the list now, not a strip of chips under it.
   *
   * The chips said the same names and the same colours as the folders they sat
   * below, and the one thing they alone did — switching space — the list does
   * without a second control: you are in the space of the page you are on.
   * What has to stay true is that a space is drawn as a folder with its pages
   * indented under it, so this holds the folder and denies the chip.
   */
  test("a space is a folder in the list, not a chip under it", async () => {
    const html = await draw();
    // ONCE. The chips said every space's name a second time, under the folders
    // that already said it — which is how a bar with ten agents in it stopped
    // fitting on screen.
    expect(html.split(">Default</span>").length - 1).toBe(1);
    // And what is left is a folder, not a chip: an icon, the name, a count.
    expect(html).toMatch(/Default<\/span><span[^>]*tabular-nums/);
  });

  test("the pages of a space are indented under it, on a rail in its colour", async () => {
    const html = await draw();
    // The rail: a left border in the space's hue, which is what makes the
    // indent read as a folder rather than as a gap.
    expect(html).toMatch(/border-left:\s*2px solid hsl\(/i);
  });

  /* The box is a state, not a bar: nothing of it is on screen until it is
     asked for, which is the whole reason the top bar could go. */
  test("the address box is not drawn until it is opened", async () => {
    const html = await draw();
    expect(html).not.toContain("Type an address, or something to search for");
  });

  /*
   * The attribute that decides whether a sign-in can happen at all.
   *
   * Without it Chromium answers `window.open` with null before the shell's
   * handler is ever asked, and every Google/SSO flow dies with "Failed to open
   * popup window… Maybe blocked by the browser?". React drops `allowpopups={true}`
   * silently — a non-boolean attribute given a boolean — so the string is the
   * whole fix, and a rendered assertion is the only thing that can see it.
   */
  test("the guest is allowed to ASK for a window", async () => {
    const mod = await import("../src/components/BrowserPanel.tsx");
    mod.__wakeFirstTab(true);
    try {
      expect(await draw()).toContain("allowpopups");
    } finally {
      mod.__wakeFirstTab(false);
    }
  });

  /*
   * The bug the real renderer's profile found: a fresh session's first tab
   * used to be created awake, so a `<webview>` — its own Chromium frame tree
   * — mounted at launch whether or not anybody had opened the browser view.
   * Asleep is the same rule every restored tab already follows; a fresh
   * session is not a reason to be the exception.
   */
  test("a fresh session with nothing saved stays asleep — no guest until it is opened", async () => {
    expect(await draw()).not.toContain("<webview");
  });
});

/*
 * A CONTAINER YOU CANNOT CLOSE.
 *
 * He pointed at a container an agent had made — no pages left in it — and asked
 * why it would not close. It could not: the heading row had a caret, a name and
 * a count and no × anywhere, the right button opened the BAR's menu ("create
 * space", "create folder", "import a sidebar from Zen"), and the only way to be
 * rid of one was the CLI verb the agent was supposed to have called itself.
 *
 * Rendered to a string, so what this pins is that the control EXISTS in the
 * first paint — it is hidden by hover styling, not by a condition.
 */
describe("a container can be closed from the bar", () => {
  const seedContainer = (id: string, name: string) => {
    store.set("agx_browser_profiles", JSON.stringify([{ id, name }]));
    store.set("agentglass.browser.session", JSON.stringify({
      v: 2, current: id,
      byProfile: { [id]: { tabs: [{ url: "https://example.com/one", title: "One", icon: null }], active: 0 } },
    }));
  };

  test("its heading carries a close button, named after the container", async () => {
    seedContainer("scheduler", "scheduler");
    const html = await draw();
    expect(html, "no way to close a container without the CLI").toContain('aria-label="Close the container scheduler"');
  });

  test("and the button says what closing it takes with it", async () => {
    seedContainer("scheduler", "scheduler");
    const html = await draw();
    expect(html).toContain("its 1 page close");
  });

  test("the default container is not offered one — there is nowhere to land if it goes", async () => {
    store.set("agentglass.browser.session", JSON.stringify({
      v: 2, current: "", byProfile: { "": { tabs: [{ url: "https://example.com/one", title: "One", icon: null }], active: 0 } },
    }));
    const html = await draw();
    expect(html).not.toContain("Close the container");
  });
});

/*
 * AND IT SITS IN THE ROW, NOT ON TOP OF IT.
 *
 * The first version was `absolute right-0.5` over the heading, so on hover the
 * × landed on the page count — the same shape he has now rejected twice,
 * "that button there, all ugly, all squashed on top". The row is a flex with a slot at its end
 * instead: the same width whether or not the container can be closed, so
 * nothing moves and nothing overlaps.
 */
describe("the close button's place in the row", () => {
  test("it is not positioned over the heading", async () => {
    store.set("agx_browser_profiles", JSON.stringify([{ id: "scheduler", name: "scheduler" }]));
    store.set("agentglass.browser.session", JSON.stringify({
      v: 2, current: "scheduler",
      byProfile: { scheduler: { tabs: [{ url: "https://example.com/one", title: "One", icon: null }], active: 0 } },
    }));
    const html = await draw();
    const at = html.indexOf('aria-label="Close the container scheduler"');
    expect(at).toBeGreaterThan(0);
    /* The button's own class list, which is where the overlap lived. React
       writes the attributes in JSX order, so it comes AFTER the aria-label. */
    const cls = html.slice(at, html.indexOf(">", at));
    expect(cls, "the × is absolutely positioned again — it will land on the count").not.toContain("absolute");
    expect(cls).toContain("group-hover:opacity-100");
  });

  test("and the default container holds the same width, so headings line up", async () => {
    store.set("agentglass.browser.session", JSON.stringify({
      v: 2, current: "", byProfile: { "": { tabs: [{ url: "https://example.com/one", title: "One", icon: null }], active: 0 } },
    }));
    const html = await draw();
    expect(html).toContain('aria-hidden="true"');
  });
});
