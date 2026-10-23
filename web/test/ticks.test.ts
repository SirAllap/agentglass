import { describe, expect, test } from "bun:test";
import { splitTicks } from "../src/lib/ticks.ts";

describe("splitTicks", () => {
  test("a server hint draws its command as code", () => {
    expect(splitTicks("not logged in — run `gh auth login`")).toEqual([
      { code: false, text: "not logged in — run " },
      { code: true, text: "gh auth login" },
    ]);
  });
  test("two spans and the words between them", () => {
    expect(splitTicks("Reads merge requests the way `gh` does for `GitHub`.")).toEqual([
      { code: false, text: "Reads merge requests the way " },
      { code: true, text: "gh" },
      { code: false, text: " does for " },
      { code: true, text: "GitHub" },
      { code: false, text: "." },
    ]);
  });
  test("a backtick with no partner stays text and swallows nothing", () => {
    expect(splitTicks("it's a ` alone")).toEqual([{ code: false, text: "it's a ` alone" }]);
  });
  test("an empty pair is not a code run", () => {
    expect(splitTicks("a `` b")).toEqual([{ code: false, text: "a `` b" }]);
  });
  test("a span never crosses a line", () => {
    expect(splitTicks("a `b\nc` d")).toEqual([{ code: false, text: "a `b\nc` d" }]);
  });
  test("plain text is one run", () => {
    expect(splitTicks("nothing here")).toEqual([{ code: false, text: "nothing here" }]);
    expect(splitTicks("")).toEqual([]);
  });
});

const row = await Bun.file(new URL("../src/components/SettingRow.tsx", import.meta.url)).text();
const kit = await Bun.file(new URL("../src/components/SettingsKit.tsx", import.meta.url)).text();

describe("where the ticks are drawn", () => {
  test("a row's help, a card's description and a check row's value all go through Ticks", () => {
    expect(row).toContain("<Ticks>{hint}</Ticks>");
    expect(kit).toContain("<Ticks>{desc}</Ticks>");
    expect(kit).toContain("<Ticks>{value}</Ticks>");
  });
});
