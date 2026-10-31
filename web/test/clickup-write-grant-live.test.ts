/* Approving the write permission left the board read-only until a reload. Read as source. */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("write permission granted from the request card", () => {
  it("re-reads the boards when the request store changes", () => {
    expect(src).toContain("settingsRequests.subscribe(() => { void loadBoards(); })");
  });
});
