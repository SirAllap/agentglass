/*
 * "Forget this computer" nulls the host while the Terminal tab is mounted.
 * A component that returns before some of its hooks renders fewer hooks than
 * the render before it, and React throws "Rendered fewer hooks than expected"
 * — which on a phone is the app process dying. Measured on an emulator: 2/2.
 *
 * There is no renderer in this project, so the rule is asserted against the
 * source: inside TerminalPane, no hook call follows a conditional `return`
 * that sits at the component's own top level.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

/** The body of `function name(`, to its own closing brace, comments removed. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name}( is gone`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

/** Lines of the top-level (two-space indent) statements that bail out. */
function hooksAfterBailOut(body: string): string[] {
  const lines = body.split("\n");
  const bail = lines.findIndex((l) => /^ {2}if \(.*\) return\b/.test(l));
  if (bail < 0) return [];
  return lines.slice(bail + 1).filter((l) => /(^|[^A-Za-z0-9_.])use[A-Z]\w*\(/.test(l));
}

describe("TerminalPane hooks", () => {
  test("no hook is called after the component's own early return", () => {
    const body = bodyOf(screen, "TerminalPane");
    expect(body).toContain("if (!host) return null;");
    expect(hooksAfterBailOut(body)).toEqual([]);
  });

  test("the detector sees a hook placed after a bail-out", () => {
    const bad = "function X() {\n  if (!host) return null;\n  const a = useRef(1);\n}\n";
    expect(hooksAfterBailOut(bodyOf(bad, "X"))).toHaveLength(1);
  });
});
