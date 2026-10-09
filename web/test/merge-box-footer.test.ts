/*
 * The merge box spends ONE footer row on buttons. It used to spend two: the
 * merge group on one line, update/draft/close on another underneath. A rule
 * about source is asserted against source, there being no renderer here.
 */
import { describe, expect, it } from "bun:test";

const box = await Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("merge box footer", () => {
  it("draws the secondary actions and the merge group in the same row", () => {
    const at = box.indexOf("{extraNode && <div");
    const merge = box.indexOf("{!path.ready && showMergeRow && <span");
    expect(at).toBeGreaterThan(0);
    expect(merge).toBeGreaterThan(at);
    // No second bordered row for extraNode.
    expect(box.match(/\{extraNode && <div className="flex[^>]*style=\{\{ borderTop/g)).toBeNull();
  });

  it("does not pin draft and close to a right edge of their own", () => {
    const at = panel.indexOf("const extraNode = (");
    const end = panel.indexOf("const hasNotes", at);
    expect(panel.slice(at, end)).not.toContain('className="ml-auto flex gap-1.5"');
  });
});
