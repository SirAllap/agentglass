import { describe, expect, test } from "bun:test";

/* The pickers drew their option rows by hand, each with its own padding, hover tint and
   corner: `px-2 py-1.5 hover:bg-white/5` in the people list, a primary 12% fill in the
   branch list, a rounded-lg beside a square one in the checkout list. They are the kit's
   `ListRow` now, so one row looks one way and the keyboard cursor and the chosen row are
   two different tints. This keeps the next picker from copying a row again. */
const PICKERS = ["PeoplePick", "AssignPicker", "TrackerPeoplePick", "BasePicker", "CheckoutPicker", "Select"];

describe("picker rows are the kit's ListRow", () => {
  for (const name of PICKERS) {
    test(`${name} imports ListRow and draws no hover:bg-white/5 row`, async () => {
      const src = (await Bun.file(new URL(`../src/components/${name}.tsx`, import.meta.url)).text())
        .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(src).toMatch(/import \{[^}]*\bListRow\b[^}]*\} from "\.\/workspace\/Chrome\.tsx"/);
      expect(src).not.toContain("hover:bg-white/5");
    });
  }
  test("ListRow carries role, aria and mouse handlers through to its button", async () => {
    const chrome = await Bun.file(new URL("../src/components/workspace/Chrome.tsx", import.meta.url)).text();
    const fn = chrome.slice(chrome.indexOf("export function ListRow("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("{...rest}");
  });
});
