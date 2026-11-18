/* Two small fixes, read from source with comments removed (the components need a
   live popover / window focus to render the case): one "Copied" label per row,
   and one disk sample in flight when focus and visibility fire together. */
import { expect, test } from "bun:test";

const read = async (f: string) => (await Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text())
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("only the row whose command was copied says Copied", async () => {
  const s = await read("PrWatchMenu.tsx");
  expect(s).toContain("useState<string | null>(null)");
  expect(s).toContain("setCopied(cmd)");
  expect(s).toContain('cmd && copied === cmd ? "Copied"');
  expect(s).not.toMatch(/\{copied \? "Copied"/);
});

test("a disk sample is skipped while one is in flight and re-armed after", async () => {
  const s = await read("MachinePanel.tsx");
  expect(s).toContain("if (sampling.current) return;");
  expect(s).toMatch(/\.finally\(\(\) => \{ sampling\.current = false; \}\)/);
});
