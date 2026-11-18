import { expect, test } from "bun:test";

const card = await Bun.file(new URL("../src/components/jira/JiraCard.tsx", import.meta.url)).text();
const act = await Bun.file(new URL("../src/components/jira/JiraActivity.tsx", import.meta.url)).text();

// The thread showed through a band between the section tabs and the sticky sub-tabs:
// the scroller pads its top by N px and a sticky box stops at the content edge, so top must be -N with N px of own padding.
test("the sticky sub-tabs reach the scroller's top edge", () => {
  const pad = Number(/className="agx-scroll[^"]*"[^>]*style=\{\{ padding: "(\d+)px 16px 16px"/.exec(card)?.[1]);
  expect(pad).toBeGreaterThan(0);
  const bar = /className="sticky ([^"]*)" style=\{\{ top: (-?\d+), background: "var\(--bg\)" \}\}/.exec(act);
  expect(bar).not.toBeNull();
  expect(Number(bar![2])).toBe(-pad);
  expect(bar![1]).toContain(`pt-${pad / 4}`);
});
