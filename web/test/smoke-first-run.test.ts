/*
 * The smoke leaves the first run by the door the wizard draws.
 *
 * A clean machine — nothing scoped, no session row, no hooks — draws the Setup
 * wizard INSTEAD of the workspace, so the rail the smoke looks for is not in
 * the document until the wizard is out of the way. The CI step boots exactly
 * that machine (its own DB, its own empty home) and reported "expected a rail
 * of view tabs, found 0", while a developer's own server — already set up, or
 * refusing with a 401 — stayed green and hid it.
 *
 * The script runs in a browser and imports nothing from the app, so the two
 * ends are read as source and held to each other: rename the Skip label, move
 * the rail the wizard announces itself by, and this goes red instead of the
 * smoke going quietly red on a runner nobody is looking at.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const smoke = read("../../scripts/smoke.ts");
const flow = read("../src/components/setup/SetupFlow.tsx");

/** The body of `skipLabel`, sliced to its own closing brace. */
function skipLabelBody(src: string): string {
  const at = src.indexOf("export function skipLabel(");
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
}

describe("the smoke and the first run", () => {
  it("clicks the words step 1 puts on its own Skip button", () => {
    const clicked = smoke.match(/const skipWords = ("(?:[^"\\]|\\.)*");/)?.[1] ?? "";
    expect(clicked).not.toBe("");
    expect(skipLabelBody(flow)).toContain(clicked);
  });

  it("finds the wizard by the label its own rail carries", () => {
    const label = smoke.match(/aside\[aria-label="([^"]+)"\]/)?.[1] ?? "";
    expect(label).not.toBe("");
    expect(flow).toContain(`<aside className="setup-rail" aria-label="${label}">`);
  });
});
