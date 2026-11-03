import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/components/agents/agentsView.css", import.meta.url)).text();
const rules = await Bun.file(new URL("../src/components/agents/AgentRulesSection.tsx", import.meta.url)).text();
const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(sel + " {")) ?? "";

// `.agv .ask` is the Waiting-on-you card (a grid with overflow hidden and a
// bottom margin). A tone class named `ask` on a segment button matched it, so
// the active "Ask me" drew a taller pill than "Allow" and "Never".
test("a segment tone class never reuses the name of a card class", () => {
  expect(css).not.toMatch(/\.tri button\.on\.(ask|allow|deny)\b/);
  expect(css).toMatch(/\.tri button\.on\.t-ask\b/);
  expect(rules).not.toMatch(/`on \$\{o\.tone\}`/);
  expect(rules).toContain("`on t-${o.tone}`");
  expect(rules).toContain('`on t-${c.mode === "default" ? "ask" : "allow"}`');
});

// A heavier weight on the active segment widened that one button, so the
// control grew and its neighbours moved when the state changed.
test("the active segment keeps the same weight as the others", () => {
  expect(rule(".agv .tri button.on")).not.toMatch(/font-weight/);
  expect(rule(".agv .tri button")).toMatch(/font-weight: 600/);
});

// A grid with no template makes one auto column, sized to its widest child:
// a long nowrap line pushed the right column past the page and the page
// scrolled sideways.
test("the column stack cannot grow past its track, and the sub line wraps", () => {
  expect(rule(".agv .cols")).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
  expect(rule(".agv .subline")).toMatch(/flex-wrap: wrap/);
});
