import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the bench button's reserve is its size plus a margin, one token", () => {
  const size = Number(/const FAB_SIZE = (\d+);/.exec(read("../src/components/bench/FloatingBench.tsx"))![1]);
  const token = Number(/--fab-reserve: (\d+)px/.exec(read("../src/index.css"))![1]);
  expect(token).toBeGreaterThan(size);
});

test("every footer bar reserves the button's width", () => {
  expect(read("../src/components/GitPanel.tsx")).toContain('paddingRight: "var(--fab-reserve)"');
  expect(read("../src/components/finder/machine/MachineFinder.tsx")).toContain('paddingRight: "var(--fab-reserve)"');
  expect(read("../src/components/docker/dockerCss.ts")).toContain("padding:0 var(--fab-reserve) 0 14px");
  expect(read("../src/jiraMock.css")).toContain("padding: 6px var(--fab-reserve) 6px 14px");
});

test("the terminal's bottom-right pill and the dashboard's scroll area clear the bench button", () => {
  expect(read("../src/components/terminal/PaneBar.tsx")).toContain("var(--fab-reserve)");
  expect(read("../src/index.css")).toContain("padding-bottom: max(var(--sb-p), var(--fab-reserve))");
});

test("Docker column header cells truncate instead of overlapping", () => {
  expect(read("../src/components/docker/dockerCss.ts")).toContain(".dk-ch>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
});

test("the terminal held-command card reserves room only for a pane at the corner", () => {
  const src = read("../src/components/TerminalPanel.tsx");
  expect(src).toContain('right: cardAtCorner ? "var(--fab-reserve)" : 12');
  expect(src).not.toContain("absolute bottom-3 right-3 max-w-[21rem]");
});
test("the browser zoom notice reserves room unless the inspector docks beside the page", () => {
  const src = read("../src/components/BrowserPanel.tsx");
  expect(src).toContain('right: dt ? 12 : "var(--fab-reserve)"');
  expect(src).not.toContain("agx-zoom-in absolute bottom-3 right-3");
});
