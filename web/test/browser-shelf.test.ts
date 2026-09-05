/*
 * The shelf: what the browser keeps between sessions.
 *
 * Worth testing hard for one reason — there is no undo. A bug in a move or a
 * delete loses an arrangement somebody built by hand over weeks, and it loses
 * it silently, at launch, in a JSON file nobody reads.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_ESSENTIALS, MAX_DEPTH, SHELF_KEY, __resetShelfIds, addFolder, allItems, canNest,
  emptyShelf, findByUrl, folderCount, place, readShelves, removeFolder, removeItem,
  mergeImported, renameFolder, sameUrl, shelfFolder, shelfItem, shelfFor, toggleFolder, withShelf,
  boundItem, looseTabs, tabForItem,
  type Shelf,
} from "../src/lib/browserShelf.ts";

// No DOM under bun, and this module reads and writes one key. A Map is enough
// to test what it does with what it finds there.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

beforeEach(() => { __resetShelfIds(); store.clear(); });

const withFolder = (name: string): { shelf: Shelf; id: string } => {
  const shelf = addFolder(emptyShelf(), name);
  return { shelf, id: shelf.folders[0]!.id };
};

describe("keeping a page", () => {
  test("a pinned page lands in the folder it was dropped on, and the folder opens", () => {
    const { shelf, id } = withFolder("Orbit");
    const closed = toggleFolder(shelf, id);
    expect(closed.folders[0]!.open).toBe(false);
    const after = place(closed, shelfItem("https://orbit.example/one", "One"), { to: "folder", id });
    expect(after.folders[0]!.items.map((i) => i.title)).toEqual(["One"]);
    // Dropping into a folded folder that stays folded is a page that vanished.
    expect(after.folders[0]!.open).toBe(true);
  });

  test("moving it out of a folder leaves nothing behind", () => {
    const { shelf, id } = withFolder("Orbit");
    const item = shelfItem("https://orbit.example/one", "One");
    const inFolder = place(shelf, item, { to: "folder", id });
    const loose = place(inFolder, item, { to: "loose" });
    expect(loose.folders[0]!.items).toEqual([]);
    expect(loose.loose.map((i) => i.title)).toEqual(["One"]);
    // And it is one page, not two.
    expect(allItems(loose)).toHaveLength(1);
  });

  test("an index puts it where it was dropped, not at the end", () => {
    let shelf = emptyShelf();
    for (const n of ["a", "b", "c"]) shelf = place(shelf, shelfItem(`https://x.example/${n}`, n), { to: "loose" });
    const moved = place(shelf, shelf.loose[2]!, { to: "loose" }, 0);
    expect(moved.loose.map((i) => i.title)).toEqual(["c", "a", "b"]);
  });
});

describe("the essentials grid", () => {
  const full = (): Shelf => {
    let shelf = emptyShelf();
    for (let i = 0; i < MAX_ESSENTIALS; i++) shelf = place(shelf, shelfItem(`https://x.example/${i}`, `#${i}`), { to: "essentials" });
    return shelf;
  };

  test("holds twelve", () => {
    expect(full().essentials).toHaveLength(12);
  });

  /*
   * The refusal has to happen BEFORE the page is taken out of where it was.
   * A remove-then-add would drop the thirteenth on the floor — dragged out of
   * a folder, refused by the grid, gone.
   */
  test("refuses the thirteenth without eating it", () => {
    const shelf = place(full(), shelfItem("https://x.example/extra", "extra"), { to: "loose" });
    const after = place(shelf, shelf.loose[0]!, { to: "essentials" });
    expect(after.essentials).toHaveLength(12);
    expect(after.loose.map((i) => i.title)).toEqual(["extra"]);
  });

  test("but reordering the twelve is not a thirteenth", () => {
    const shelf = full();
    const after = place(shelf, shelf.essentials[11]!, { to: "essentials" }, 0);
    expect(after.essentials).toHaveLength(12);
    expect(after.essentials[0]!.title).toBe("#11");
  });
});

describe("folders", () => {
  test("a folded folder still counts what its children hold", () => {
    const inner = shelfFolder("Inner");
    inner.items = [shelfItem("https://x.example/1"), shelfItem("https://x.example/2")];
    const outer = shelfFolder("Outer");
    outer.items = [shelfItem("https://x.example/3")];
    outer.folders = [inner];
    // Three, not one: a count that ignores the children says the opposite of
    // the truth on exactly the folder you cannot see into.
    expect(folderCount(outer)).toBe(3);
  });

  test("deleting one keeps the pages", () => {
    const { shelf, id } = withFolder("Orbit");
    const filled = place(shelf, shelfItem("https://orbit.example/one", "One"), { to: "folder", id });
    const after = removeFolder(filled, id);
    expect(after.folders).toEqual([]);
    expect(after.loose.map((i) => i.title)).toEqual(["One"]);
  });

  test("renaming refuses to blank the name", () => {
    const { shelf, id } = withFolder("Orbit");
    expect(renameFolder(shelf, id, "   ").folders[0]!.name).toBe("Orbit");
    expect(renameFolder(shelf, id, " Acme ").folders[0]!.name).toBe("Acme");
  });

  test("nesting stops at the depth the column can draw", () => {
    let shelf = addFolder(emptyShelf(), "one");
    let id = shelf.folders[0]!.id;
    for (let d = 1; d < MAX_DEPTH; d++) {
      expect(canNest(shelf, id)).toBe(true);
      shelf = addFolder(shelf, `deeper ${d}`, id);
      const walk = (fs: typeof shelf.folders): string => (fs[0]!.folders.length ? walk(fs[0]!.folders) : fs[0]!.id);
      id = walk(shelf.folders);
    }
    expect(canNest(shelf, id)).toBe(false);
  });
});

describe("finding a page that is already kept", () => {
  test("ignores a trailing slash and a fragment", () => {
    expect(sameUrl("https://orbit.example/a/", "https://orbit.example/a#top")).toBe(true);
    expect(sameUrl("https://orbit.example/a", "https://orbit.example/b")).toBe(false);
    // Empty is not a match for empty: a tab with no address is not "the same
    // page" as another tab with no address.
    expect(sameUrl("", "")).toBe(false);
  });

  test("looks everywhere, essentials included", () => {
    const { shelf, id } = withFolder("Orbit");
    const kept = place(shelf, shelfItem("https://orbit.example/deep", "Deep"), { to: "folder", id });
    expect(findByUrl(kept, "https://orbit.example/deep/")?.title).toBe("Deep");
    expect(findByUrl(kept, "https://orbit.example/other")).toBe(null);
  });
});

describe("what comes back off disk", () => {
  test("essentials are shared by every space and kept in one place", () => {
    const shelf = place(emptyShelf(), shelfItem("https://x.example/e", "E"), { to: "essentials" });
    const all = withShelf({}, "work", shelf);
    // Stored once, under the default space...
    expect(all.work!.essentials).toEqual([]);
    expect(all[""]!.essentials.map((i) => i.title)).toEqual(["E"]);
    // ...and read back by a space that has never seen them.
    expect(shelfFor(all, "personal").essentials.map((i) => i.title)).toEqual(["E"]);
  });

  test("a hand-edited file cannot smuggle in a page with no address or a fourth level", () => {
    localStorage.setItem(SHELF_KEY, JSON.stringify({
      "": {
        essentials: [{ url: "" }, { url: "https://ok.example" }, "nonsense"],
        folders: [{ name: "a", folders: [{ name: "b", folders: [{ name: "c", folders: [{ name: "d" }] }] }] }],
      },
    }));
    const shelf = shelfFor(readShelves(), "");
    expect(shelf.essentials.map((i) => i.url)).toEqual(["https://ok.example"]);
    const depth = (fs: typeof shelf.folders, d = 1): number => (fs.length ? depth(fs[0]!.folders, d + 1) : d - 1);
    expect(depth(shelf.folders)).toBe(MAX_DEPTH);
  });

  test("nothing saved is an empty shelf rather than a crash", () => {
    expect(shelfFor(readShelves(), "")).toEqual(emptyShelf());
    localStorage.setItem(SHELF_KEY, "{ this is not json");
    expect(readShelves()).toEqual({});
  });
});

describe("taking a page off the shelf", () => {
  test("finds it wherever it is", () => {
    const { shelf, id } = withFolder("Orbit");
    const item = shelfItem("https://orbit.example/one", "One");
    for (const spot of [{ to: "folder" as const, id }, { to: "loose" as const }, { to: "essentials" as const }]) {
      const kept = place(shelf, item, spot);
      expect(allItems(kept)).toHaveLength(1);
      expect(allItems(removeItem(kept, item.id))).toHaveLength(0);
    }
  });
});

/*
 * Bringing a sidebar in from another browser.
 *
 * The rule that matters is that it ADDS. The shelf is arranged by hand and
 * there is no undo; an import that replaced it would be the most expensive
 * button in the app.
 */
describe("importing another browser's sidebar", () => {
  const imported = {
    spaces: [{ id: "sp-1", name: "Work" }, { id: "sp-2", name: "Home" }],
    folders: [
      { id: "g1", name: "Orbit", parent: null, space: "sp-1", collapsed: false },
      { id: "g2", name: "Inner", parent: "g1", space: "sp-1", collapsed: true },
      { id: "g3", name: "Elsewhere", parent: null, space: "sp-2", collapsed: false },
    ],
    items: [
      { url: "https://orbit.example/one", title: "One", icon: null, folder: "g1", space: "sp-1", essential: false },
      { url: "https://orbit.example/two", title: "Two", icon: null, folder: "g2", space: "sp-1", essential: false },
      { url: "https://orbit.example/loose", title: "Loose", icon: null, folder: null, space: "sp-1", essential: false },
      { url: "https://acme.example/", title: "Acme", icon: null, folder: null, space: "sp-2", essential: true },
      { url: "https://home.example/", title: "Home", icon: null, folder: "g3", space: "sp-2", essential: false },
    ],
  };

  test("takes the space you asked for, with its nesting intact", () => {
    const out = mergeImported(emptyShelf(), imported, "sp-1").shelf;
    expect(out.folders.map((f) => f.name)).toEqual(["Orbit"]);
    expect(out.folders[0]!.folders.map((f) => f.name)).toEqual(["Inner"]);
    expect(out.folders[0]!.items.map((i) => i.title)).toEqual(["One"]);
    expect(out.folders[0]!.folders[0]!.items.map((i) => i.title)).toEqual(["Two"]);
    expect(out.loose.map((i) => i.title)).toEqual(["Loose"]);
    // Another space's folder and its pages stay behind.
    expect(out.folders.map((f) => f.name)).not.toContain("Elsewhere");
  });

  test("but an essential comes across whatever space it was in — that is what one is", () => {
    expect(mergeImported(emptyShelf(), imported, "sp-1").shelf.essentials.map((i) => i.title)).toEqual(["Acme"]);
  });

  test("a folded folder arrives folded", () => {
    const out = mergeImported(emptyShelf(), imported, "sp-1").shelf;
    expect(out.folders[0]!.open).toBe(true);
    expect(out.folders[0]!.folders[0]!.open).toBe(false);
  });

  test("importing twice does not duplicate a page", () => {
    const once = mergeImported(emptyShelf(), imported, "sp-1").shelf;
    const twice = mergeImported(once, imported, "sp-1").shelf;
    expect(allItems(twice)).toHaveLength(allItems(once).length);
  });

  test("and what was already kept by hand stays exactly where it was", () => {
    const mine = place(emptyShelf(), shelfItem("https://orbit.example/one", "My own name"), { to: "essentials" });
    const out = mergeImported(mine, imported, "sp-1").shelf;
    expect(out.essentials.map((i) => i.title)).toContain("My own name");
    expect(allItems(out).filter((i) => sameUrl(i.url, "https://orbit.example/one"))).toHaveLength(1);
  });

  test("an essential past the twelfth is kept rather than dropped", () => {
    const many = {
      ...imported,
      items: Array.from({ length: 14 }, (_, n) => ({
        url: `https://x.example/${n}`, title: `#${n}`, icon: null, folder: null, space: "sp-1", essential: true,
      })),
    };
    const out = mergeImported(emptyShelf(), many, "sp-1").shelf;
    expect(out.essentials).toHaveLength(MAX_ESSENTIALS);
    expect(out.loose.map((i) => i.title)).toEqual(["#12", "#13"]);
  });

  /*
   * The silence that read as a bug.
   *
   * Four pages he had already kept by hand were skipped — correctly, they were
   * still in HIS folder — and the imported folder came up five short with
   * nothing on screen to say why. The count is what the panel says out loud.
   */
  test("says how many it left alone", () => {
    const first = mergeImported(emptyShelf(), imported, "sp-1");
    expect([first.added, first.already]).toEqual([4, 0]);
    const again = mergeImported(first.shelf, imported, "sp-1");
    expect([again.added, again.already]).toEqual([0, 4]);
  });
});

/*
 * A kept page that follows a link is still the kept page.
 *
 * His report, and the whole of the bug: open the page kept in a folder, press
 * a link inside it, and the browser looked like it had opened a second tab —
 * the folder entry went dark and the same tab appeared in the loose list
 * underneath. Nothing had been opened. The binding between a kept page and its
 * tab was the ADDRESS, and the address is exactly what a link changes.
 */
describe("a kept page and the tab showing it", () => {
  const url = "https://orbit.example/agent/to-do-list/";
  const shelfWithItem = () => {
    const sh = place(emptyShelf(), shelfItem(url, "To-do list"), { to: "loose" });
    return { sh, item: sh.loose[0]! };
  };

  test("bound by identity, so following a link keeps it in its folder", () => {
    const { sh, item } = shelfWithItem();
    const tab = { id: "t1", url, shelfId: item.id };
    expect(boundItem(tab, sh)?.id).toBe(item.id);

    // The link. Same tab, another page.
    const moved = { ...tab, url: "https://orbit.example/agent/history/" };
    expect(boundItem(moved, sh)?.id).toBe(item.id);
    expect(looseTabs([moved], sh)).toEqual([]);
    expect(tabForItem([moved], item, sh)?.id).toBe("t1");
  });

  test("without the binding it drops out the moment the url changes", () => {
    // The old behaviour, kept as the thing this must never go back to.
    const { sh, item } = shelfWithItem();
    const strayed = { id: "t2", url: "https://orbit.example/agent/history/" };
    expect(boundItem(strayed, sh)).toBeNull();
    expect(looseTabs([strayed], sh)).toHaveLength(1);
    expect(item.url).toBe(url);
  });

  test("a tab that merely happens to be on a kept page is still drawn once", () => {
    // Typed by hand, or followed from somewhere else: it is that page, so the
    // shelf entry is where it is drawn and the loose list does not repeat it.
    const { sh, item } = shelfWithItem();
    const same = { id: "t3", url };
    expect(boundItem(same, sh)?.id).toBe(item.id);
    expect(looseTabs([same], sh)).toEqual([]);
  });

  test("deleting the kept page leaves the tab an ordinary one", () => {
    const { sh, item } = shelfWithItem();
    const tab = { id: "t4", url: "https://orbit.example/agent/history/", shelfId: item.id };
    const without = removeItem(sh, item.id);
    expect(boundItem(tab, without)).toBeNull();
    expect(looseTabs([tab], without)).toHaveLength(1);
  });
});

/*
 * Taking a page off the shelf leaves it open, below.
 *
 * His words: pressing the × on a kept row should move it to the ordinary tabs,
 * not make it disappear. The trap is that the shelf is full of pages from one
 * site, so an un-kept tab is adopted straight back by the next entry holding
 * the same address — which is why "un-kept" is a value rather than an absence.
 */
describe("un-keeping a page", () => {
  const url = "https://orbit.example/dash/";
  test("the tab drops into the loose list and is not adopted back", () => {
    let sh = place(emptyShelf(), shelfItem(url, "Dash"), { to: "loose" });
    sh = place(sh, shelfItem(url, "Dash again"), { to: "loose" });
    const [first, second] = sh.loose;
    const tab = { id: "t1", url, shelfId: first!.id };
    expect(boundItem(tab, sh)?.id).toBe(first!.id);

    // The ×: the entry goes, and the tab is marked deliberately un-kept.
    const without = removeItem(sh, first!.id);
    const unkept = { ...tab, shelfId: "" };
    expect(boundItem(unkept, without)).toBeNull();
    expect(looseTabs([unkept], without)).toHaveLength(1);
    // Without the mark, the OTHER entry on the same address would take it.
    expect(boundItem({ ...tab, shelfId: undefined }, without)?.id).toBe(second!.id);
  });
});
