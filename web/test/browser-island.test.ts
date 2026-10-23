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
