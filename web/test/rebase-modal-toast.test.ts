// A rebase that finished closed its modal and said nothing.
import { expect, it } from "bun:test";

it("a finished rebase reports itself, and the panel flashes it", async () => {
  const modal = await Bun.file(new URL("../src/components/RebaseModal.tsx", import.meta.url)).text();
  const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
  expect(modal).toContain("onDone(`Rebased ");
  expect(panel).toMatch(/onDone=\{\(m\) => \{[^}]*flash\(true, m\)/);
});
