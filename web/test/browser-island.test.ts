import { describe, expect, test } from "bun:test";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const island = strip(await Bun.file(new URL("../src/components/browser/BrowserIsland.tsx", import.meta.url)).text());
const presence = strip(await Bun.file(new URL("../src/components/browser/AgentPresence.tsx", import.meta.url)).text());

describe("overview margin beside a guest scrollbar", () => {
  // A <webview> draws its own scrollbar under the card's 12px margin, so the right
  // and bottom gaps read wider or narrower than the left and top ones.
  test("the card, its glass and its content all move in by the scrollbar the page draws", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/\.agx-isl-glass \{[^}]*right: calc\(12px \+ var\(--sbr, 0px\)\)[^}]*bottom: calc\(12px \+ var\(--sbb, 0px\)\)/);
    expect(css).toMatch(/\.agx-isl\.is-open \{ clip-path: inset\(0px var\(--sbr, 0px\) var\(--sbb, 0px\) 0px round 20px\)/);
    expect(css).toMatch(/\.agx-isl-mc \{ position: absolute; inset: 0 var\(--sbr, 0px\) var\(--sbb, 0px\) 0;/);
    expect(island).toContain("p.gutter(front)");
  });
});

describe("island pill", () => {
  // A tab an agent had touched an hour earlier still showed "agent · working"
  // with no rim, no pointer and no Take over on the page.
  test("names a driver only while the page shows one", () => {
    expect(island).toContain("const live = useAgentLive(act);");
    expect(island).toMatch(/const driving = !!act && !act\.paused && live;/);
    expect(presence).toContain("const live = useAgentLive(agent);");
  });

  // The dot next to the agent's name went green, grey, green on every call of a
  // continuous run: it read the raw in-flight count, which is 0 between two asks.
  test("the dot is lit on the glass's clock, not on the raw in-flight count", () => {
    expect(island).toContain("const { held } = useGlass(act, live);");
    expect(island).toMatch(/const working = driving && held;/);
    expect(island).not.toMatch(/act!?\.working > 0/);
  });

  // The pill named the act and the dock repeated it: the state lives in the dock only.
  test("names the agent and nothing it is doing", () => {
    expect(island).toContain('>{act!.agent}</span>');
    expect(island).not.toContain("p.doing");
  });
});

describe("the glass over a driven page", () => {
  const css = Bun.file(new URL("../src/index.css", import.meta.url));
  // A person's hover over a page an agent drove opened menus mid-task.
  test("is up while the agent is mid-ask, not for the linger, and takes the pointer", async () => {
    expect(presence).toContain('{glassUp && <div ref={glass} className="agx-presence-glass"');
    // The glass sat over a tab nobody was acting on for the whole 30 s linger, and ate the wheel.
    expect(presence).toContain("return { held, up: held && acting };");
    expect(presence).toContain("const held = !!agent && glassHeld({ live, done: agent.done, paused: agent.paused, working }, stilled);");
    expect(presence).toContain("setTimeout(() => setStilled(true), GLASS_QUIET_MS)");
    expect(presence).toMatch(/export const GLASS_QUIET_MS = 10_000;/);
    // An agent that only read the person's tab locked it for thirty seconds.
    expect(presence).toContain('else if (working > 0 && (isActVerb(op) || MOVES.has(op))) setActing(true);');
    expect(await css.text()).toMatch(/\.agx-presence-glass \{[^}]*pointer-events: auto/);
  });
});

describe("the pointer and the keys", () => {
  // After a navigation the pointer kept pointing at the old page's spot, over whatever replaced it.
  test("the pointer leaves with the page and comes back with the next act", () => {
    expect(presence).toMatch(/if \(p !== seenUrl\.current\) \{ seenUrl\.current = p; setStale\(true\); \}/);
    // Every click on a same-page #link changed the address and hid the pointer for good.
    expect(presence).toContain("const seenUrl = useRef(pageOf(url));");
    expect(presence).toContain("setStale(false);");
  });
  test("the glass takes the focus from this tab's page only", () => {
    expect(presence).toContain('a.tagName === "WEBVIEW" && root.current?.parentElement?.contains(a)');
  });
});

const menuSrc = strip(await Bun.file(new URL("../src/components/browser/IslandMenu.tsx", import.meta.url)).text());
const panel = strip(await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text());

describe("the island's own menu", () => {
  // The island's ⋯ opened the classic bar's twenty-five rows over a floating pill.
  test("the island opens the small menu and the classic bar keeps the full one", () => {
    expect(panel).toContain("const barMenu = menuOpen && menuAtXY && classic ? (");
    expect(panel).toContain("const islandMenu = menuOpen && menuAtXY && !classic ? (");
    const mine = panel.slice(panel.indexOf("const islandMenu ="), panel.indexOf("const sideBody ="));
    for (const row of ["Home", "New tab", "Find on this page", "Copy the address", "Reload, ignoring the cache", "Zoom back to 100%", "Open in your own browser", "Classic tab list"])
      expect(mine).toContain(`label: "${row}"`);
    expect(mine.match(/label: "/g)!.length).toBe(8);
  });
  // The menu is portalled out of the island, so the pointer leaving for it dropped :hover and the bar went back to the top edge.
  test("the bar stays down while the menu is open", () => {
    expect(island).toContain('(peek || p.menuOpen ? " is-peek" : "")');
    expect(panel).toContain("menuOpen={menuOpen}");
  });
  // A key press has no origin to grow from.
  test("a keyboard open does not animate", () => {
    expect(island).toContain("p.onMenu(e.currentTarget.getBoundingClientRect(), e.detail === 0)");
    expect(menuSrc).toContain('(byKey ? "" : " is-anim")');
  });
});

describe("the tucked island", () => {
  test("goes up to the edge only when folded all the way, never while its bar is shown", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    const rule = css.split("\n").find((l) => /^\.agx-isl\.is-tucked[^{]*\{\s*top:\s*0;/.test(l));
    expect(rule).toBeDefined();
    for (const s of [":not(.is-open)", ":not(:hover)", ":not(.is-peek)", ":not(:focus-within)"]) expect(rule!).toContain(s);
  });
});

describe("the overview as islands", () => {
  const cssP = Bun.file(new URL("../src/index.css", import.meta.url)).text();
  const overview = island.slice(island.indexOf('<div className="agx-isl-mc">'));
  const rule = (css: string, sel: string) => css.split("\n").filter((l) => l.startsWith(sel + " {"));

  // Done, Waiting and Yours are quiet: a violet halo on an island nobody is working on says someone is.
  test("only an island with an agent at work carries the halo and the satellite", () => {
    expect(island).toContain('const isWork = (k: AgentStateKey | undefined | null) => !!k && k !== "done" && k !== "waiting" && k !== "yours";');
    expect(overview).toContain("const work = isWork(g.state?.key);");
    expect(overview).toMatch(/\{work && <><span className="agx-isl-halo" aria-hidden \/>(<i className="agx-isl-sat[^>]*\/>){3}<\/>\}/);
    expect(overview.match(/agx-isl-halo/g)!.length).toBe(1);
  });

  test("the summary is a capsule of three counts, the way out is top right and the hint is at the bottom", () => {
    expect(overview).toContain("<strong>{groups.length}</strong>");
    expect(overview).toContain("<strong>{tabs.length}</strong>");
    expect(overview).toContain('className="agx-isl-ib agx-isl-away" aria-label="Close" onClick={() => hide()}');
    expect(overview).toContain('<p className="agx-isl-hint" aria-hidden>esc to close</p>');
  });

  // The big dashed New tab tile is gone; the round + keeps the same click.
  test("a round + after the tabs opens a new tab, and no New tab tile is left", async () => {
    const css = await cssP;
    expect(overview.match(/className="agx-isl-add" aria-label="New tab" title="New tab" onClick=\{\(\) => \{ setOpen\(false\); p\.onNew\((g\.profile)?\); \}\}/g)!.length).toBe(2);
    expect(island).not.toContain("agx-isl-new");
    expect(css).not.toContain("agx-isl-new");
  });

  test("every tab keeps its click, its keys and its own close button", () => {
    expect(overview).toContain("onClick={() => hide(t.id)}");
    expect(overview).toContain('if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hide(t.id); }');
    expect(overview).toContain("p.onClose(t.id); }}");
    expect(overview).toContain("pics[t.id] ?");
  });

  // Springs out of the pill: measured offsets, staggered, critically damped, transform and opacity only, under 400 ms.
  test("the opening stays under 400 ms, never overshoots and moves only transform and opacity", async () => {
    const css = await cssP;
    const shown = rule(css, ".agx-isl.is-shown .agx-isl-box")[0];
    expect(shown).toBeDefined();
    const [d0, k, dur] = [10, 28, 290];
    expect(shown).toContain(`calc(${d0}ms + var(--i, 0) * ${k}ms)`);
    expect(shown).toContain(`transform ${dur}ms var(--agx-spring)`);
    expect(d0 + 3 * k + dur).toBeLessThan(400); // --i is capped at 3 in the component
    expect(overview).toContain('"--i": Math.min(i, 3)');
    const props = [...shown.matchAll(/(opacity|transform|translate|[a-z-]+) \d+ms/g)].map((m) => m[1]);
    expect(props.sort()).toEqual(["opacity", "transform", "translate"]);
    const pts = css.match(/--agx-spring: linear\(([^)]*)\)/)![1].split(",").map(Number);
    expect(pts.length).toBeGreaterThan(8);
    expect(Math.max(...pts)).toBeLessThanOrEqual(1);
    expect(island).toContain('b.style.setProperty("--fx"');
  });

  test("an island has no blur of its own: the glass under it is the one blur", async () => {
    const css = await cssP;
    for (const sel of [".agx-isl-box", ".agx-isl-sum, .agx-isl-away"]) for (const l of rule(css, sel)) expect(l).not.toContain("backdrop-filter");
    const box = css.slice(css.indexOf(".agx-isl-box { position: relative;"), css.indexOf(".agx-isl-box:hover"));
    expect(box).not.toContain("backdrop-filter");
  });

  test("reduced motion: no entrance, a still halo and a satellite parked on the edge", async () => {
    const css = await cssP;
    const from = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .agx-isl { transition: background 150ms ease; }");
    expect(from).toBeGreaterThan(0);
    expect(css.slice(from, css.indexOf("\n}\n", from))).toContain(".agx-isl-box, .agx-isl.is-shown .agx-isl-box { opacity: 1; transform: none; transition: none; }");
    const still = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .agx-isl-halo");
    expect(still).toBeGreaterThan(0);
    const block = css.slice(still, css.indexOf("\n}\n", still));
    expect(block).toContain(".agx-isl-halo, .agx-isl-state, .agx-st-tick { animation: none;");
    expect(block).toContain("animation: none; offset-distance: 12%;");
  });

  test("colours follow the theme: islands and capsule are built from the theme's background, not white", async () => {
    const css = await cssP;
    const box = css.slice(css.indexOf(".agx-isl-box { position: relative;"), css.indexOf(".agx-isl-box:hover"));
    expect(box).toContain("var(--bg)");
    expect(box).not.toMatch(/#fff\b|rgba\(255, 255, 255/);
    expect(rule(css, ".agx-isl-sum, .agx-isl-away")[0]).toContain("var(--bg)");
  });
});

describe("an island's +", () => {
  test("opens the new tab in that island's container", async () => {
    const isl = await Bun.file(new URL("../src/components/browser/BrowserIsland.tsx", import.meta.url)).text();
    expect(isl).toContain("p.onNew(g.profile)");
    const panel = await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text();
    expect(panel).toMatch(/onNew=\{\(space\) => \{ if \(space !== undefined\) switchTo\(space\); setOmni\("new"\); \}\}/);
  });
});

describe("the dock keeps one footprint", () => {
  // A chip that came and went made the capsule shrink and sag with the state.
  test("the chip is always drawn, and a changing word crosses over instead of swapping", () => {
    expect(presence).toContain('<span className="agx-presence-state"><Swap k={state.key}>');
    expect(presence).not.toMatch(/\?\s*<span className="agx-presence-state"/);
    expect(presence).toContain('<Swap k={agent.paused ? "back" : "take"}>');
    expect(presence).toContain('className="agx-sw-lay is-out" aria-hidden');
  });
  test("Take over wears the alien and Hand back the spark, and the alien looks from the ghost's state", () => {
    expect(presence).toContain("<><SparkGlyph />Hand back</> : <><AlienGlyph />Take over</>");
    expect(presence).toContain("lookAt(p.left + ghost.x");
    expect(presence).toContain("if (ghost && !stale && !calmNow())");
  });
  test("reduced motion stops the follow, the pulse and the crossfade", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .agx-presence-ghost"));
    const body = rm.slice(0, rm.indexOf("\n}\n"));
    expect(body).toContain(".agx-presence-dock button * { animation: none; }");
    expect(body).toContain(".agx-al-head, .agx-al-eyes { transform: none; transition: none; }");
    expect(body).toContain(".agx-sw-lay.is-out { opacity: 0; }");
  });
});

describe("dock blots", () => {
  // Grey translucent blocks and circles sat over "Clicking" and "Take over": a
  // backdrop-filter dock whose children animate forever (the click ring, the swap
  // layers) is a stale-compositor-tile risk, and a pointer label drawn above the
  // dock washes the button. The dock is opaque enough without the blur, and it
  // stacks above the pointer by number, not by DOM order.
  test("the dock has no backdrop-filter and stacks above the ghost pointer", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    const dock = css.slice(css.indexOf(".agx-presence-dock {"), css.indexOf("@keyframes agx-dock-in"));
    expect(dock).not.toContain("backdrop-filter");
    const z = (sel: string) => Number(new RegExp(`${sel.replace(/\./g, "\\.")} \\{[^}]*z-index: (\\d+)`).exec(css)?.[1]);
    expect(z(".agx-presence-dock")).toBeGreaterThan(z(".agx-presence-ghost"));
  });
});

describe("mission control: which tab the agent is in", () => {
  // The agent's tab was a faint violet ring in a row of identical pictures. It now
  // carries a thick ring, its state on the picture and in words, and the rest of
  // a live box steps back; the person's own tab is a different colour.
  test("the agent's tab is marked, named and set apart from the person's", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(island).toContain('(driven ? " is-driven" : "")');
    expect(island).toContain("`Agent · ${st.word}`");
    expect(island).toContain('(work && !driven ? " is-dim" : "")');
    expect(css).toMatch(/\.agx-isl-card\.is-driven \.agx-isl-thumb \{[^}]*0 0 0 3px var\(--ink-agent\)/);
    expect(css).toMatch(/\.agx-isl-card\.is-on:not\(\.is-driven\) \.agx-isl-thumb \{[^}]*var\(--ink-you\)/);
  });
});

describe("mission control: many tabs in one container", () => {
  // 13 tabs in one box ran as a single row past the box's right edge: the last
  // tile sat under the "+". The box now stops at the width of its container and
  // the row wraps, so the "+" follows the last tab onto whichever row it lands.
  test("the box is capped at its container and its row wraps", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/\.agx-isl-box \{[^}]*max-width: 100%/);
    expect(css).toMatch(/\.agx-isl-row \{[^}]*flex-wrap: wrap/);
  });
});

describe("mission control: many containers", () => {
  // 8 containers of 15 tabs ran off the bottom with the agent's own container
  // somewhere in the middle and nothing to search with. Working containers come
  // first, the pictures shrink, a field narrows the list, and the count says how
  // many agents are working rather than how many ever touched a tab.
  test("working containers lead, the list is searchable and the count says who works", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(island).toMatch(/rank\(a\.g\) - rank\(b\.g\) \|\| a\.i - b\.i/);
    expect(island).toContain("const rank = (g: (typeof boxes)[number]) => (isWork(g.state?.key) ? 0 : g.held ? 1 : 2);");
    expect(island).toContain('className="agx-isl-find"');
    expect(island).toContain('{busyAgents === agents.length ? "working"');
    expect(css).toMatch(/\.agx-isl-boxes\.is-dense \.agx-isl-thumb \{ height: 64px; \}/);
  });
});

/* The dock's Take over and state chip are a Swap: a host whose width is set from
   the word inside it. Measured once per word, a dock that mounted in a hidden
   panel kept width 0 (a 26 px button, the label outside it) and a font-size
   change left the label 11 px past its host, until the word next changed. */
describe("dock crossfade width", () => {
  const from = presence.indexOf("function Swap(");
  const swap = presence.slice(from, presence.indexOf("\n}\n", from));

  test("the host follows every size change of its word, not one measurement", () => {
    expect(from).toBeGreaterThan(-1);
    expect(swap).toContain("new ResizeObserver(fit)");
    expect(swap).toContain("ro.observe(el)");
    expect(swap).not.toContain("offsetWidth");
  });

  test("the chip's floor grows with the font size, so no state word moves Take over", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/\.agx-presence-state \.agx-sw \{ height: 20px; min-width: calc\([\d.]+em \+ 20px\); \}/);
    expect(presence).not.toContain("min={");
  });
});
