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
  test("is up for as long as the island names the agent, and takes the pointer", async () => {
    expect(presence).toContain('{live && <div className="agx-presence-glass"');
    expect(await css.text()).toMatch(/\.agx-presence-glass \{[^}]*pointer-events: auto/);
  });
});
