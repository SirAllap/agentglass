import { describe, expect, test } from "bun:test";

const pr = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/FileRail.tsx", import.meta.url)).text();

describe("a date shown as an age also shows the whole timestamp", () => {
  test("PrPanel has agoFull and the Commits row, the events and the comment headers use it", () => {
    expect(pr).toContain("function agoFull(");
    expect((pr.match(/agoFull\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(pr).toContain("title={agoFull(c.committedAt)}");
  });
  test("the file rail's 'said about this file' entries carry it too", () => {
    expect(rail).toContain("${stampOf(m.createdAt)}");
  });
});
