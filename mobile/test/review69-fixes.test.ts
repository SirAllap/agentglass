/*
 * Two fixes from the phone review: a move must not be sendable twice while its
 * comment is in flight, and "Merge when green" must not stay armed once the
 * shared gate refuses it. No renderer here, so asserted against source.
 */
import { describe, expect, test } from "bun:test";

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

describe("review fixes", () => {
  test("the move sheet stays busy until the comment is sent", async () => {
    const src = await read("../src/jira/MoveSheet.tsx");
    const from = src.indexOf("const send = async");
    const body = src.slice(from, src.indexOf("return (", from));
    const comment = body.indexOf('"/jira/comment"');
    expect(comment).toBeGreaterThan(-1);
    const before = body.slice(0, comment);
    // The only setBusy(false) before the comment is on the failure return.
    expect((before.match(/setBusy\(false\)/g) ?? []).length).toBe(1);
    expect(before).toMatch(/kind === "failed"\) \{ setBusy\(false\)/);
    expect(body.slice(comment)).toContain("setBusy(false)");
  });

  test("auto-merge is sent only while the gate allows it", async () => {
    const src = await read("../app/pr/[number].tsx");
    expect(src).toMatch(/const autoOn = auto && !refusals\?\.autoRefusal/);
    expect(src).toContain("auto: autoOn,");
    expect(src).toContain("checked={autoOn}");
    expect(src).toContain('label={autoOn ? "Merge when green"');
  });
});
