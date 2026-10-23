/*
 * Reopening the finder puts every view back where the person left it, not on the
 * selection. Icons keeps a first item (a tile row holds another number of tiles
 * in another width), List and Columns keep pixels; each is told to the store
 * and handed back by the same folder.
 */
import { describe, expect, test } from "bun:test";
import { iconsFirstItem, iconsTopOf } from "../src/lib/finderMiller.ts";
import { readMachineSnap, writeMachineSnap, type MachineSnap } from "../src/lib/finderMachineState.ts";

const folderViews = await Bun.file(new URL("../src/components/finder/machine/FolderViews.tsx", import.meta.url)).text();
const machine = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
const virtual = await Bun.file(new URL("../src/components/finder/machine/VirtualList.tsx", import.meta.url)).text();

describe("icons scroll in items", () => {
  test("a row at the top becomes its first item and back", () => {
    expect(iconsFirstItem(920, 92, 6)).toBe(60);
    expect(iconsTopOf(60, 92, 6)).toBe(920);
  });
  test("another width keeps the same row of items, not the same pixels", () => {
    const first = iconsFirstItem(920, 92, 6);
    expect(iconsTopOf(first, 92, 4)).toBe(15 * 92);
  });
  test("the part of a row scrolled past survives the round trip (3333 came back as 3240)", () => {
    for (const top of [3333, 6050, 6000, 0, 107, 108, 1479]) expect(iconsTopOf(iconsFirstItem(top, 108, 6), 108, 6)).toBe(top);
    expect(Math.floor(iconsFirstItem(3333, 108, 6))).toBe(30 * 6);
  });
  test("a first item in the middle of a row lands on that row; nothing is negative", () => {
    expect(iconsTopOf(63, 92, 6)).toBe(920);
    expect(iconsFirstItem(-5, 92, 6)).toBe(0);
  });
});

describe("the store", () => {
  const snap: MachineSnap = { v: 1, trail: ["/home/ann"], sel: [null], focusCol: 0, scroll: { "/home/ann": 340 }, iconsFirst: { "/home/ann": 60 }, dragged: {}, peek: false };
  test("the first item round-trips and a stranger folder is dropped", () => {
    expect(readMachineSnap(writeMachineSnap(snap))?.iconsFirst).toEqual({ "/home/ann": 60 });
    const bad = JSON.parse(writeMachineSnap(snap)); bad.iconsFirst = { "/elsewhere": 3, "/home/ann": -1 };
    expect(readMachineSnap(JSON.stringify(bad))?.iconsFirst).toEqual({});
  });
});

describe("every view reports and restores", () => {
  test("Icons and List are handed their place and tell it", () => {
    expect(machine).toMatch(/<IconsView [^>]*firstItem=\{iconsFirst\.current\[lastCol\.path\]\} onFirstItem=/);
    expect(machine).toMatch(/<ListView [^>]*scrollTop=\{scrolls\.current\[lastCol\.path\]\} onScrollTop=/);
    expect(folderViews).toMatch(/initialTop=\{firstItem === undefined/);
    expect(folderViews).toMatch(/initialTop=\{scrollTop\} onTop=\{onScrollTop\}/);
  });
  test("a stored top of zero is a place too: the cursor does not pull the list back", () => {
    expect(virtual).toContain("useRef(initialTop !== undefined)");
  });
  test("the restore waits for a measured box and for a list tall enough (a folder arrives in pages)", () => {
    expect(virtual).toMatch(/!ready \|\| !h\) return/);
    expect(virtual).toContain("el.scrollHeight - el.clientHeight < initialTop");
    expect(folderViews).toContain("ready={width > 0}");
  });
});

describe("a link wants its file in view", () => {
  test("the scroll of the folder a request points at is dropped, the others stay", async () => {
    const { scrollWithout } = await import("../src/lib/finderMachineState.ts");
    const before = { "/home/ann/orbit": 900, "/home/ann": 40 };
    expect(scrollWithout(before, ["/home/ann/orbit/a.md", "/home/ann/orbit", null])).toEqual({ "/home/ann": 40 });
    expect(scrollWithout(undefined, ["/x"])).toEqual({});
    expect(before["/home/ann/orbit"]).toBe(900);
  });
  test("the finder uses it for both stores", () => {
    expect(machine).toContain("scrollWithout(back?.scroll, asked)");
    expect(machine).toContain("scrollWithout(back?.iconsFirst, asked)");
  });
  // Finder open, link into a folder visited before: the column is drawn fresh with the remembered scroll and never reveals the file.
  test("an external move while the finder is open forgets the folder's scroll first", () => {
    for (const start of ['const at = externalPlace(start, wantFile ?? null);', 'const at = externalPlace(start, wantFile);', 'if (move === "stay") return;']) {
      const at = machine.indexOf(start);
      expect(at).toBeGreaterThan(-1);
      const to = machine.indexOf('guarded("external"', at);
      expect(machine.slice(at, to)).toMatch(/forgetScroll\(/);
    }
    const fn = machine.slice(machine.indexOf("const forgetScroll = "), machine.indexOf("// Closing the finder unmounts it"));
    expect(fn).toContain("scrollWithout(scrolls.current");
    expect(fn).toContain("scrollWithout(iconsFirst.current");
  });
});
