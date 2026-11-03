/* "Shell here" opened a tmux window and said nothing. It answers in the footer now. Read as source. */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("Shell here on a Local task", () => {
  it("reports success as well as failure, with a way to the terminal on success", () => {
    const i = src.indexOf("requestTermIssue(cwd, name,");
    expect(i).not.toBe(-1);
    const s = src.slice(i, i + 500);
    expect(s).toContain("Shell opened");
    expect(s).toContain("terminalNote(done.ok");
  });
});
