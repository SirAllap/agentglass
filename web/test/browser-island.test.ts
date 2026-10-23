import { describe, expect, test } from "bun:test";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const island = strip(await Bun.file(new URL("../src/components/browser/BrowserIsland.tsx", import.meta.url)).text());
const presence = strip(await Bun.file(new URL("../src/components/browser/AgentPresence.tsx", import.meta.url)).text());

describe("island pill", () => {
  // A tab an agent had touched an hour earlier still showed "agent · working"
  // with no rim, no pointer and no Take over on the page.
  test("names a driver only while the page shows one", () => {
    expect(island).toContain("const live = useAgentLive(act);");
    expect(island).toMatch(/const driving = !!act && !act\.paused && live;/);
    expect(presence).toContain("const live = useAgentLive(agent);");
  });

  // The pill named the act and the dock repeated it: the state lives in the dock only.
  test("names the agent and nothing it is doing", () => {
    expect(island).toContain('<span className="agx-isl-doing-t">{act!.agent}</span>');
    expect(island).not.toContain("p.doing");
  });
});

describe("the glass over a driven page", () => {
  const css = Bun.file(new URL("../src/index.css", import.meta.url));
  // A person's hover over a page an agent drove opened menus mid-task.
  test("is up while the agent is mid-ask, not for the linger, and takes the pointer", async () => {
    expect(presence).toContain('{glassUp && <div ref={glass} className="agx-presence-glass"');
    // The glass sat over a tab nobody was acting on for the whole 30 s linger, and ate the wheel.
    expect(presence).toContain("const glassUp = live && acting && (agent.working > 0 || held);");
    // An agent that only read the person's tab locked it for thirty seconds.
    expect(presence).toContain('else if (agent.working > 0 && (isActVerb(agent.op ?? "") || MOVES.has(agent.op ?? ""))) setActing(true);');
    expect(await css.text()).toMatch(/\.agx-presence-glass \{[^}]*pointer-events: auto/);
  });
});

describe("the pointer and the keys", () => {
  // After a navigation the pointer kept pointing at the old page's spot, over whatever replaced it.
  test("the pointer leaves with the page and comes back with the next act", () => {
    expect(presence).toMatch(/if \(url !== seenUrl\.current\) \{ seenUrl\.current = url; setStale\(true\); \}/);
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
    expect(overview).toMatch(/const work = !!g\.state && g\.state\.key !== "done" && g\.state\.key !== "waiting" && g\.state\.key !== "yours";/);
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
    expect(overview.match(/className="agx-isl-add" aria-label="New tab" title="New tab" onClick=\{\(\) => \{ setOpen\(false\); p\.onNew\(\); \}\}/g)!.length).toBe(2);
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
