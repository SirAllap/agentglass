/*
 * One push button, not four.
 *
 * The PR panel's `Btn`, the git card's `RowAction`, Docker's row action and
 * the browser column's tool had each drawn its own `<button>` with its own
 * radius (4px, 8px, 6px, 6px) and height (24/28, 28, 22, 24), so the same
 * kind of control changed shape from view to view. They are thin wrappers
 * over `Button` in `workspace/Chrome.tsx` now; this asserts none of them grew
 * its own `<button>` back.
 *
 * Source is read as text, per this repo's rule for a decision that belongs on
 * the screen: there is no renderer here to mount the components and look.
 */
import { describe, expect, it } from "bun:test";

const src = (p: string) => Bun.file(new URL(`../src/components/${p}`, import.meta.url).pathname).text();
const FILES = {
  "PrPanel.tsx": await src("PrPanel.tsx"),
  "git/ui.tsx": await src("git/ui.tsx"),
  "BrowserPanel.tsx": await src("BrowserPanel.tsx"),
  "workspace/Chrome.tsx": await src("workspace/Chrome.tsx"),
} as const;

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The function's own body: from its signature to the first top-level `}` that
 *  closes it (a line holding only `}`), never a fixed window. */
function body(file: keyof typeof FILES, signature: string): string {
  const text = FILES[file];
  const at = text.indexOf(signature);
  expect(at).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", at);
  expect(end).toBeGreaterThan(at);
  return stripComments(text.slice(at, end + 2));
}

const WRAPPERS: [keyof typeof FILES, string][] = [
  ["git/ui.tsx", "export function RowAction("],
  ["BrowserPanel.tsx", "function SideTool("],
];

describe("the button wrappers render through Button", () => {
  it("PrPanel.tsx has no wrapper of its own: it draws the kit's Button directly", () => {
    // The fourth wrapper, `Btn`, only renamed Button's props; its uses are Button now.
    const code = stripComments(FILES["PrPanel.tsx"]);
    expect(code).not.toMatch(/function Btn\(/);
    expect(code).not.toMatch(/<Btn[\s>]/);
    expect(code).toMatch(/<Button[\s>]/);
    expect(FILES["PrPanel.tsx"]).toMatch(/import \{[^}]*\bButton\b[^}]*\} from "[^"]*Chrome\.tsx"/);
  });

  for (const [file, sig] of WRAPPERS) {
    it(`${file} ${sig.replace(/\($/, "")}`, () => {
      const b = body(file, sig);
      expect(b).toMatch(/<Button[\s>]/);
      expect(b).not.toMatch(/<button[\s>]/);
      expect(FILES[file]).toMatch(/import \{[^}]*\bButton\b[^}]*\} from "[^"]*Chrome\.tsx"/);
    });
  }

  it("Button takes its height from CTRL_H and its corners from the canon", () => {
    const b = body("workspace/Chrome.tsx", "export function Button(");
    expect(b).toContain("CTRL_H[size]");
    expect(b).toContain("rounded-lg");
    expect(b).not.toMatch(/\brounded(-md|-sm)?\b(?!-)/);
  });

  it("the PR Files toolbar is one row at one height: every Button in it is compact", () => {
    const text = FILES["PrPanel.tsx"];
    const from = text.indexOf('placeholder="Filter files…"');
    const to = text.indexOf('"Collapse all"', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const row = text.slice(from, to);
    // An arrow function's `=>` is not the end of the tag.
    const btns = row.match(/<Button\b(?:=>|[^>])*>/g) ?? [];
    expect(btns.length).toBeGreaterThanOrEqual(6);
    for (const b of btns) expect(b).toMatch(/size="compact"/);
  });
});
