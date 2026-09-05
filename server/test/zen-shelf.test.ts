/*
 * Reading somebody's Zen sidebar.
 *
 * The fixture is written here rather than copied from a profile: the only real
 * input is one person's private browsing, and the SHAPE is what this has to get
 * right — which entries a tab is at, which tabs count as kept, and the join
 * between a tab and its folder.
 *
 * That join is the whole thing. A tab does not name its folder; it carries
 * Firefox's `groupId`, and Zen's folder ids are its group ids. Measured on a
 * real profile: 14 folders, 14 groups, the same fourteen ids. Get it wrong and
 * the import is a flat list of ninety pages.
 */
import { describe, expect, test } from "bun:test";
import { mapZenSessions } from "../src/zenshelf.ts";

const tab = (over: Record<string, unknown>) => ({
  entries: [{ url: "https://orbit.example/one", title: "One" }],
  pinned: true,
  ...over,
});

describe("what comes back", () => {
  const shelf = mapZenSessions({
    spaces: [{ uuid: "sp-1", name: "Work" }, { uuid: "sp-2", name: "Personal" }],
    folders: [
      { id: "g1", name: "Orbit", parentId: null, workspaceId: "sp-1", collapsed: false },
      { id: "g2", name: "Inner", parentId: "g1", workspaceId: "sp-1", collapsed: true },
    ],
    tabs: [
      tab({ groupId: "g1", zenWorkspace: "sp-1", zenPinnedIcon: "data:image/png;base64,AA" }),
      tab({ groupId: "g2", zenWorkspace: "sp-1", entries: [{ url: "https://orbit.example/two", title: "Two" }] }),
      tab({ groupId: undefined, zenEssential: true, pinned: false, entries: [{ url: "https://acme.example/", title: "Acme" }] }),
      // Open at the time, kept by nobody.
      tab({ pinned: false, entries: [{ url: "https://noise.example/", title: "Noise" }] }),
    ],
  });

  test("spaces and folders come across with their nesting", () => {
    expect(shelf.spaces.map((s) => s.name)).toEqual(["Work", "Personal"]);
    expect(shelf.folders.map((f) => [f.name, f.parent])).toEqual([["Orbit", null], ["Inner", "g1"]]);
  });

  test("only the kept pages — an open tab is not an arrangement", () => {
    expect(shelf.items.map((i) => i.title)).toEqual(["One", "Two", "Acme"]);
  });

  test("each one knows its folder, through the group id", () => {
    expect(shelf.items.map((i) => i.folder)).toEqual(["g1", "g2", null]);
  });

  test("and which ones are the grid at the top", () => {
    expect(shelf.items.filter((i) => i.essential).map((i) => i.title)).toEqual(["Acme"]);
  });

  test("the icon Zen drew is preferred to the one the page last offered", () => {
    expect(shelf.items[0]!.icon).toBe("data:image/png;base64,AA");
  });
});

describe("the awkward parts of a session store", () => {
  test("`index` is one-based, and it is where the tab actually is", () => {
    const shelf = mapZenSessions({
      tabs: [tab({
        index: 2,
        entries: [
          { url: "https://orbit.example/before", title: "Before" },
          { url: "https://orbit.example/now", title: "Now" },
        ],
      })],
    });
    expect(shelf.items[0]!.url).toBe("https://orbit.example/now");
  });

  test("an index past the end falls back to the last entry rather than to nothing", () => {
    const shelf = mapZenSessions({ tabs: [tab({ index: 9 })] });
    expect(shelf.items[0]!.url).toBe("https://orbit.example/one");
  });

  /* A kept page you cannot open is a row that only ever disappoints. */
  test("about: and file: pins are dropped", () => {
    const shelf = mapZenSessions({
      tabs: [
        tab({ entries: [{ url: "about:newtab" }] }),
        tab({ entries: [{ url: "file:///home/somebody/secret.html" }] }),
        tab({ entries: [] }),
      ],
    });
    expect(shelf.items).toEqual([]);
  });

  test("a group id no folder claims is a pin without a folder, not a broken one", () => {
    const shelf = mapZenSessions({
      folders: [{ id: "g1", name: "Orbit" }],
      tabs: [tab({ groupId: "gone" })],
    });
    expect(shelf.items[0]!.folder).toBe(null);
  });

  test("a file with nothing in it reads as an empty shelf", () => {
    expect(mapZenSessions({})).toEqual({ spaces: [], folders: [], items: [] });
  });

  test("a tab with no title still arrives, named by nothing rather than dropped", () => {
    const shelf = mapZenSessions({ tabs: [tab({ entries: [{ url: "https://orbit.example/x" }] })] });
    expect(shelf.items[0]).toMatchObject({ url: "https://orbit.example/x", title: "" });
  });
});
