/*
 * The palette's screen, asserted against its source.
 *
 * There is no renderer here, so what the screen must not do again is pinned at
 * the seam that fixed it. Each of these was measured in the running palette
 * before it was written: a list of names at 1.2:1 on a light theme, another
 * tab's folder under a scope pill that said something else, a path clicked in
 * a terminal that left the box empty, a copy button that gave no sign.
 */
import { describe, expect, test } from "bun:test";

const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
const preview = await Bun.file(new URL("../src/components/finder/Preview.tsx", import.meta.url)).text();

const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no closing brace for ${head}`);
};
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the names in the list are readable", () => {
  const row = code(bodyOf(palette, "function RowView("));

  test("a name takes the text colour, never a file-type tint", () => {
    expect(row).toContain("NAME_INK.name");
    expect(row.includes("icon.tint")).toBe(false);
    expect(/color:\s*icon\./.test(row)).toBe(false);
  });

  test("only size and age are muted, and never below the text3 tier", () => {
    const ink = palette.match(/export const NAME_INK = [^\n]*/)?.[0] ?? "";
    expect(ink).toContain('name: "var(--text)"');
    expect(ink.includes("text4")).toBe(false);
  });

  test("on the cursor row the muted ink steps up so the tint behind it cannot sink it", () => {
    expect(row).toContain("metaOnCursor");
  });
});

describe("each tab owns its folder", () => {
  test("tabs are changed through switchTab, by click and by key", () => {
    expect(palette).toContain("switchTab(stash.current");
    expect(/\bsetTab\(t\.id\)/.test(code(palette))).toBe(false);
    expect(/setTab\(TABS\[/.test(code(palette))).toBe(false);
  });
});

describe("a path clicked in a terminal", () => {
  test("puts the path in the box", () => {
    const effect = code(palette.slice(palette.indexOf("handledTarget.current = target.n;"), palette.indexOf("const [pathText")));
    expect(effect).toContain("setQ(pathInputText(dir, homeDir))");
    expect(effect.includes('setQ("")')).toBe(false);
  });

  test("the caret lands at the end of a path instead of selecting all of it", () => {
    expect(palette).toContain("focusSelection(el.value)");
  });
});

describe("the bar", () => {
  test("is one bar of buttons, with no separate Back", () => {
    expect(palette).toContain("<PathBar");
    expect(code(palette).includes("Back to the place you picked")).toBe(false);
    const bar = code(bodyOf(palette, "function PathBar("));
    expect(bar).toContain("<button");
    expect(bar).toContain("aria-current");
  });

  test("a jump from the bar goes through jump(), which keeps the box and the folder in step", () => {
    expect(palette).toContain("onGo={jump}");
  });
});

describe("feedback and the file manager", () => {
  test("copying flashes, and the flash is cancelled when the pane goes away", () => {
    const p = code(preview);
    expect(p).toContain("copyFlash.current?.fire()");
    expect(p).toContain("copyFlash.current?.cancel()");
    expect(p).toContain("copyLabel(");
  });

  test("the file manager is offered for the folder and for the row", () => {
    expect(code(palette)).toContain("<RevealButton");
    expect(code(preview)).toContain("<RevealButton");
  });
});

describe("the where menu", () => {
  test("has a Places and a Recent section and one cursor over both", () => {
    expect(palette).toContain('heading("Places")');
    expect(palette).toContain('heading("Recent")');
    expect(palette).toContain("placeSections(");
    expect(palette).toContain('role="listbox"');
  });
});

describe("open in browser", () => {
  test("the pane offers it, the palette falls back to the system opener, and Enter is untouched", () => {
    expect(code(preview)).toContain("canOpenInBrowser(facts.name)");
    expect(code(palette)).toContain("onOpenBrowser(withToken(pageUrl(SERVER, p)))");
    expect(code(palette)).toContain("api.previewOpen(p)");
    const open = code(bodyOf(palette, "const openRow = useCallback("));
    expect(open.includes("onOpenBrowser")).toBe(false);
  });
});
