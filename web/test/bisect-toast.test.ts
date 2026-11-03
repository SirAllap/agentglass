// Bisect start, mark and reset closed or updated the modal without a word.
import { expect, it } from "bun:test";

it("each bisect step reports itself through onChanged", async () => {
  const src = await Bun.file(new URL("../src/components/BisectModal.tsx", import.meta.url)).text();
  expect(src).toContain("onChanged(`Marked ${m}`)");
  expect(src).toContain('onChanged("Bisect started")');
  expect(src).toContain('onChanged("Bisect ended")');
});
