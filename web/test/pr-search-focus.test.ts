/*
 * The search box's focus panel asks nobody for anything and its keys stay in
 * it. No renderer in this project, so this reads source: the rules are
 * asserted against the text that implements them.
 */
import { describe, expect, it } from "bun:test";
import { focusItems } from "../src/lib/useSearchFocus.ts";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const BAR = code(await read("../src/components/PrFilterBar.tsx"));
const PANEL = code(await read("../src/components/prs/SearchFocusPanel.tsx"));
const HOOK = code(await read("../src/lib/useSearchFocus.ts"));

describe("no request on focus or typing", () => {
  it("the panel, its hook and the stores never reach the network", async () => {
    for (const s of [PANEL, HOOK, code(await read("../src/lib/prSearchMemory.ts")), code(await read("../src/lib/prFollow.ts"))]) {
      expect(s).not.toMatch(/\bapi\./);
      expect(s).not.toMatch(/\bfetch\(/);
    }
  });

  it("the box's change and focus handlers ask nobody", () => {
    const change = BAR.slice(BAR.indexOf("onChange={(e)"), BAR.indexOf("onKeyDown"));
    expect(change).not.toMatch(/onSearch|focus\.run|focus\.openPerson/);
    const focus = BAR.slice(BAR.indexOf("onFocus={"), BAR.indexOf("placeholder="));
    expect(focus).not.toMatch(/onSearch|focus\.run|focus\.openPerson|api\./);
  });

  it("only a chosen row runs a search, and it goes through the panel's one road", async () => {
    const panel = await read("../src/components/PrPanel.tsx");
    expect(panel).toContain("const searchText = useCallback(");
    expect(code(panel)).toContain("useSearchFocus(repo?.key, mentions?.users ?? null, { run: searchText, openPerson })");
  });
});

describe("the keys belong to the popover", () => {
  it("Up and Down are read only while the panel (or the @ menu) is open", () => {
    const keys = BAR.slice(BAR.indexOf("const onKey = "), BAR.indexOf("  return (\n    <>"));
    for (const m of keys.matchAll(/e\.key === "Arrow(?:Up|Down)"/g)) {
      const before = keys.slice(0, m.index);
      const guard = Math.max(before.lastIndexOf("if (panelOpen)"), before.lastIndexOf("if (menuOpen && flat.length)"));
      expect(guard).toBeGreaterThan(-1);
    }
  });

  it("Escape closes the panel and stops there", () => {
    expect(BAR).toMatch(/e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); setPanelShut\(true\)/);
  });

  it("typing hides the panel and Enter on no row is the ordinary search", () => {
    expect(BAR).toContain("!query.trim()");
    expect(BAR).toMatch(/e\.key === "Enter" && row >= 0/);
  });
});

describe("what the panel walks", () => {
  it("people first, then saved, then recent", () => {
    const items = focusItems({
      followed: ["ana"], suggested: [], saved: [{ q: "#9" }], recent: [{ q: "fix", at: 1 }],
    });
    expect(items.map((i) => `${i.kind}:${i.value}`)).toEqual(["person:ana", "saved:#9", "recent:fix"]);
  });
});
