/* A disabled assignee button on a read-only board said nothing about why. Read as source. */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("read-only assignee button", () => {
  it("says why it is disabled", () => {
    const i = src.indexOf("<button ref={whoBtn} disabled={!writable}");
    expect(i).not.toBe(-1);
    expect(src.slice(i, i + 500)).toContain("title={writable ? undefined :");
  });

  it("sits in a row that carries the lock and asks to turn changes on", () => {
    const i = src.indexOf("<button ref={whoBtn} disabled={!writable}");
    expect(src.slice(src.lastIndexOf("<ReadOnlyRow", i), i)).toContain("onAllow={onAllow}");
  });
});
