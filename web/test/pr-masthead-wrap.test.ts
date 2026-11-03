import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

test("the masthead's meta row wraps in every band, so its chips never draw over each other", () => {
  const at = src.indexOf('<div className={`flex items-center gap-y-1.5 text-[12px]');
  expect(at).toBeGreaterThan(-1);
  const line = src.slice(at, src.indexOf("\n", at));
  expect(line).toContain("flex-wrap");
  expect(line).not.toContain("flex-nowrap");
});

test("the one lane the narrow board shows is centred, so the dock's rail allowance is air on both sides", async () => {
  const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
  expect(board).toContain('justifyContent: narrowBoard ? "center" : undefined');
});

test("the stack chip beside the branch is never squeezed: the branch truncates first", async () => {
  const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
  const at = css.indexOf(".agx-stk-t {");
  expect(at).toBeGreaterThan(-1);
  expect(css.slice(at, css.indexOf("}", at))).toContain("flex: none");
});
