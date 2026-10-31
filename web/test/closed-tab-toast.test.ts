import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/terminal/CloseLayer.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
const start = src.indexOf("export function ReopenToast(");
const body = code(src.slice(start, src.indexOf("\n}\n", start)));

// The parent passes a new onDismiss on every render and the Terminal re-renders
// all the time: with it in the effect's deps the 5 s timer restarted forever and
// the toast never left.
test("the dismiss timer does not depend on the callback identity", () => {
  expect(body).toMatch(/useRef\(onDismiss\)/);
  expect(body).toMatch(/\}, \[toast\.n, held\]\)/);
  expect(body).not.toMatch(/\[[^\]]*onDismiss[^\]]*\]\)/);
});

test("it is held while hovered or focused, and has a Dismiss button", () => {
  expect(body).toContain("onPointerEnter");
  expect(body).toContain("onFocus");
  expect(body).toContain('aria-label="Dismiss"');
});

// A white pill (var(--text) as background) on the dark app was off-theme.
test("it uses the house surface tokens, not the inverted text colour", () => {
  expect(body).toContain("var(--surface-card)");
  expect(body).toContain("var(--surface-lift)");
  expect(body).not.toMatch(/background: "var\(--text\)"/);
});
