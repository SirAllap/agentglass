/*
 * Customize… as Strata draws it: a close button in the header, the emoji picker
 * the card composer already has (search, category tabs, grid) instead of a bare
 * text field, and the look shown on the pinned row of the sidebar as well as in
 * the columns, icons and list.
 */
import { describe, expect, test } from "bun:test";

const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();

describe("Customize…", () => {
  test("it has a close button and opens the shared emoji picker, not a text box", async () => {
    const t = await src("components/finder/machine/FinderCustomize.tsx");
    expect(t).toContain('aria-label="Close"');
    expect(t).toContain("<EmojiPicker");
    expect(t).not.toContain("Type or paste");
  });
  test("a pinned row wears the chosen look", async () => {
    const t = await src("components/finder/machine/Sidebar.tsx");
    expect(t).toContain("useItemStyle(");
    expect(t).toContain("<StyledIcon");
  });
  test("columns, icons and list all draw through RowIcon, which reads the store", async () => {
    const col = await src("components/finder/machine/Column.tsx");
    const views = await src("components/finder/machine/FolderViews.tsx");
    expect(col).toContain("<PathIcon");
    expect(views.match(/<RowIcon /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("one reader for the chosen look", () => {
  test("every view that draws an item goes through PathIcon, which reads the store by the item's path", async () => {
    const icon = await src("components/finder/machine/StrataIcon.tsx");
    expect(icon).toContain("export function PathIcon(");
    expect(icon.slice(icon.indexOf("export function PathIcon("))).toContain("useItemStyle(path)");
    for (const f of ["QuickLook", "FinderSearch"]) {
      const t = await src(`components/finder/machine/${f}.tsx`);
      expect(t).toContain("<PathIcon");
      expect(t).not.toContain("<FileTypeIcon");
    }
  });
  test("a Columns row names its folder: the icon of a row with no folder to say cannot be found in the store", async () => {
    const col = await src("components/finder/machine/Column.tsx");
    expect(col).not.toMatch(/<RowIcon row=\{r\} \/>/);
    const views = await src("components/finder/machine/FolderViews.tsx");
    expect(views).not.toMatch(/<RowIcon row=\{r\} \/>/);
  });
});
