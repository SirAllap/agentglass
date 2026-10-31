/*
 * Where the Polaris pieces sit and what they may call, read from source (there is no renderer
 * here): the card above the page's others and following its scope, no polling, no call that
 * merges or posts, Assisted setup behind the engine, and the house tokens in the new files.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const dir = new URL("../src/components/polaris/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
const text = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await Bun.file(new URL(f, dir)).text()] as const)));
const pane = await Bun.file(new URL("../src/components/orchestration/OrchestrationPane.tsx", import.meta.url)).text();
const agents = await Bun.file(new URL("../src/components/agents/AgentsView.tsx", import.meta.url)).text();
const coord = await Bun.file(new URL("../src/components/agents/CoordinatorCard.tsx", import.meta.url)).text();
const sections = await Bun.file(new URL("../src/components/agents/AgentsSections.tsx", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const all = code(Object.values(text).join("\n"));

describe("the card in Settings > Orchestration", () => {
  test("it sits above the first existing card and follows the page's scope", () => {
    const at = pane.indexOf("<PolarisCard root={root} />");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(pane.indexOf("<QuickSetup q={q}"));
    expect(at).toBeGreaterThan(pane.indexOf("<ScopeBar"));
  });
  test("the header comment no longer says nothing on the page has a setting id", () => {
    expect(pane).not.toContain("Nothing on this page has a setting id");
    expect(pane).toContain("polaris.door.<door>");
  });
  test("the page's comment about polling still stands: nothing in the new files polls", () => {
    expect(all).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });
});

describe("what the Polaris pieces may call", () => {
  test("the only write to the world beyond settings is a click: act, beacon send, edit, discard, settings save", () => {
    const calls = [...all.matchAll(/\bapi\.([a-z]\w*)\(/g)].map((m) => m[1]);
    expect(new Set(calls)).toEqual(new Set(["polarisSettings", "polarisSettingsSave", "polarisItems", "polarisAct", "polarisBeaconSend", "polarisBeaconEdit", "polarisBeaconDiscard", "workerRoles", "prLocalHead"]));
  });
  test("no call pattern for merge, comment, label, review or card move", () => {
    expect(all).not.toMatch(/pr merge["'`]|\/comments|\/labels|\/reviews|moveCard|cardMove/);
  });
  test("nothing is copied to the clipboard: the cleared item opens GitHub", () => {
    expect(all).not.toMatch(/clipboard/);
    expect(code(text["PolarisSection.tsx"]!)).not.toMatch(/gh pr/);
  });
  test("a sync is posted only from a click handler, with the head the person saw", () => {
    const view = code(text["PolarisSection.tsx"]!);
    expect(view.match(/type: "sync"/g)).toHaveLength(2);
    expect(view.match(/type: "sync", headSha: (item|it)\.headSha/g)).toHaveLength(2);
    expect(view).not.toMatch(/useEffect\([^)]*polarisAct/);
  });
  test("a click sends a beacon only through the person's Send, with the idle sessions as choices", () => {
    expect(text["PolarisSection.tsx"]).toContain("api.polarisBeaconSend");
    expect(agents).toMatch(/sorted\.idle\.filter/);
  });
  test("editing or discarding a draft never reaches the send route", () => {
    const view = code(text["PolarisSection.tsx"]!);
    const edit = view.slice(view.indexOf("const save = async"), view.indexOf("return (", view.indexOf("const save = async")));
    expect(edit).toContain("api.polarisBeaconEdit");
    expect(edit).toContain("api.polarisBeaconDiscard");
    expect(edit).not.toContain("polarisBeaconSend");
    expect(view.match(/api\.polarisBeaconSend\(/g)).toHaveLength(1);
  });
  test("a relaunch is never a click: no action of that type is posted", () => {
    expect(all).not.toMatch(/type: "relaunch"/);
  });
});

describe("the desk key", () => {
  test("every Polaris write carries it, since the server answers a write only to the person", () => {
    for (const verb of ["polarisSettingsSave", "polarisAct", "polarisBeaconSend", "polarisBeaconEdit", "polarisBeaconDiscard"]) {
      const at = api.indexOf(`  ${verb}: (`);
      expect(at, verb).toBeGreaterThan(0);
      expect(api.slice(at, api.indexOf("\n  /**", at)), verb).toContain("deskHeader()");
    }
  });
});

describe("Assisted setup", () => {
  const card = code(text["PolarisCard.tsx"]!);
  test("it asks the engine of the builder role and is disabled without one, with a link to Agent engines", () => {
    expect(card).toContain("askBuilderOnBench(root, assistPrompt(root)");
    expect(card).toContain("disabled={!ready || noProject || busy}");
    expect(card).toContain('openSettings("engines")');
    expect(card).toContain("See Agent engines");
  });
  // Measured in the card's 366px column: two buttons beside the words sat on top of the hint.
  test("its two buttons go under the words, not beside them", () => {
    expect(card).toContain('<SettingRow label="Assisted setup" wide');
  });
});

describe("the Agents view", () => {
  test("the Pull requests section sits between Waiting on you and Working", () => {
    const w = agents.indexOf("<WaitingSection");
    const p = agents.indexOf("<PullRequestsSection");
    const k = agents.indexOf("<WorkingSection");
    expect(w).toBeGreaterThan(0);
    expect(p).toBeGreaterThan(w);
    expect(k).toBeGreaterThan(p);
  });
  test("Waiting on you counts and draws the Polaris rows", () => {
    expect(agents).toContain("extraCount={polWaiting}");
    expect(sections).toContain("count={items.length + extraCount}");
    expect(sections).toContain("{extra}");
  });
  test("the Coordinator card gains the Polaris chip only while it is on", () => {
    expect(agents).toContain("polaris={chipLabel(pol.settings)}");
    expect(coord).toContain("{polaris && <span");
  });
  test("Refresh asks Polaris again with everything else, and nothing polls", () => {
    expect(agents).toContain("onClick={reloadAll}");
  });
});

describe("the house rules in the new files", () => {
  test("no bracketed radius, no hand-written rule, no local piece named like a kit one", () => {
    expect(all).not.toMatch(/rounded-\[/);
    expect(all).not.toMatch(/"1px solid var\(--surface-line\)"/);
    for (const kit of ["Button", "Chip", "Badge", "Card", "Row", "Segmented", "Select", "Switch", "Toggle", "Disclosure", "Section"]) {
      expect(all, kit).not.toMatch(new RegExp(`function ${kit}\\(`));
    }
  });
  test("icons take the ladder, not numbers", () => {
    expect(all).not.toMatch(/Icon size=\{\d/);
  });
  test("a control sits in the same place in every state: the card header's action slot", () => {
    const card = code(text["PolarisCard.tsx"]!);
    expect(card.match(/actions=\{/g)?.length).toBe(2);
    expect(card).toContain(">Turn on</Button>");
    expect(card).toContain(">Turn off</Button>");
  });
});
