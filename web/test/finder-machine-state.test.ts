/*
 * Closing the finder is not leaving it: it comes back at the same folder chain,
 * selection, scroll and preview, also after the app restarts. What is stored is
 * only believed when it still draws — a path that is not absolute, a chain whose
 * columns are not each a child of the one before, or a number that is not one.
 */
import { describe, expect, test } from "bun:test";
import { openingOf, readMachineSnap, snapApplies, writeMachineSnap, type MachineSnap } from "../src/lib/finderMachineState.ts";
import { RECENT } from "../src/lib/finderMiller.ts";

const snap: MachineSnap = {
  v: 1, trail: ["/home/ann", "/home/ann/code", "/home/ann/code/orbit"], sel: ["code", "orbit", "README.md"], focusCol: 2,
  scroll: { "/home/ann/code/orbit": 340 }, dragged: { "/home/ann/code": 280 }, peek: false, prevDrag: 410,
};

describe("round trip", () => {
  test("what was written is what comes back", () => { expect(readMachineSnap(writeMachineSnap(snap))).toEqual(snap); });
  test("nothing stored, or damage, is nothing: the caller starts at its own place", () => {
    expect(readMachineSnap(null)).toBeNull();
    expect(readMachineSnap("{not json")).toBeNull();
    expect(readMachineSnap("42")).toBeNull();
    expect(readMachineSnap(JSON.stringify({ ...snap, v: 2 }))).toBeNull();
  });
});

describe("only what still draws", () => {
  const read = (o: object) => readMachineSnap(JSON.stringify({ ...snap, ...o }));
  test("a relative or empty first column is refused", () => {
    expect(read({ trail: ["code"], sel: ["x"] })).toBeNull();
    expect(read({ trail: [], sel: [] })).toBeNull();
  });
  test("a chain is cut where a column is not the child of the one before", () => {
    const r = read({ trail: ["/home/ann", "/home/ann/code", "/tmp/elsewhere"], sel: ["code", "x", "y"] });
    expect(r?.trail).toEqual(["/home/ann", "/home/ann/code"]);
    expect(r?.sel).toEqual(["code", "x"]);
  });
  test("a selection list is the length of the chain, missing names are null", () => {
    expect(read({ sel: ["code"] })?.sel).toEqual(["code", null, null]);
    expect(read({ sel: ["a", "b", "c", "d", "e"] })?.sel).toEqual(["a", "b", "c"]);
    expect(read({ sel: ["code", 7, null] })?.sel).toEqual(["code", null, null]);
  });
  test("the focused column is inside the chain", () => {
    expect(read({ focusCol: 9 })?.focusCol).toBe(2);
    expect(read({ focusCol: -3 })?.focusCol).toBe(0);
    expect(read({ focusCol: "x" })?.focusCol).toBe(0);
  });
  test("scroll and widths keep only numbers that make sense, for columns still in the chain", () => {
    const r = read({ scroll: { "/home/ann/code/orbit": -5, "/home/ann/code": 12, "/gone": 9, "/home/ann": "x" }, dragged: { "/home/ann/code": 20, "/gone": 300 } });
    expect(r?.scroll).toEqual({ "/home/ann/code": 12 });
    expect(r?.dragged).toEqual({});
  });
  test("a peek and a preview width are optional and typed", () => {
    expect(read({ peek: "yes", prevDrag: "wide" })?.peek).toBe(false);
    expect(read({ prevDrag: "wide" })?.prevDrag).toBeUndefined();
  });
});

describe("the finder uses it", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
  test("reads on mount and writes on change", async () => {
    const s = await src;
    expect(s).toContain("readMachineSnap(");
    expect(s).toContain("writeMachineSnap(");
  });
});

describe("reopen: the last place wins, an outside move is consumed once", () => {
  const written = (origin: string, trail0: string) => readMachineSnap(writeMachineSnap({ ...snap, origin, trail: [trail0], sel: ["x"], focusCol: 0 }))!;
  test("external open X, navigate to Y and select a file, close, reopen: Y and the file", () => {
    // The palette's place stayed X (columns never report it); the snapshot says where the person went.
    const s = written("/home/ann/notes", "/home/ann");
    expect(snapApplies(s, "/home/ann/notes")).toBe(true);
    expect(s.trail[0]).toBe("/home/ann");
    expect(s.sel[0]).toBe("x");
  });
  test("a place moved from outside while the finder was closed beats the memory, once", () => {
    const s = written("/home/ann/notes", "/home/ann");
    expect(snapApplies(s, "/home/ann/orbit")).toBe(false);
    // the finder then writes under the new place, and that one wins next time
    expect(snapApplies(written("/home/ann/orbit", "/home/ann/orbit"), "/home/ann/orbit")).toBe(true);
  });
  test("a snapshot from before origin was kept is believed by its first column", () => {
    const old = readMachineSnap(writeMachineSnap(snap))!;
    expect(old.origin).toBeUndefined();
    expect(snapApplies(old, "/home/ann")).toBe(true);
    expect(snapApplies(old, "/home/ann/code")).toBe(false);
  });
});

/*
 * Reopening lands where it was closed, in every view and every kind of place.
 * Measured: a path the palette had been asked for (a terminal link, a click in a
 * preview) stayed in its query after the finder had gone there, and every later
 * mount replayed it as a fresh request, so closing in a project folder and
 * reopening a second later landed in the folder of the old link. A request is
 * one shot: once the finder has acted on it, the next opening has none.
 */
describe("reopening", () => {
  const home = "/home/ann";
  const places: [string, string[]][] = [
    ["a project folder", [home, `${home}/Documents`, `${home}/Documents/orbit`]],
    ["Recent", ["recent:"]],
    ["the Trash", [`${home}/.local/share/Trash/files`]],
    ["a remote mount", ["/run/user/1000/gvfs/sftp:host=build.example", "/run/user/1000/gvfs/sftp:host=build.example/srv"]],
  ];
  // the view (Columns / Icons / List) and the sidebar (open, rail, hidden) are prefs of their own; the place is the same whichever is on
  for (const view of ["columns", "icons", "list"])
    for (const side of ["open", "rail", "hidden"])
      for (const [what, trail] of places)
        test(`${what}, ${view} view, sidebar ${side}: navigate, close, reopen = same folder`, () => {
          const t = trail[0] === "recent:" ? [RECENT] : trail;
          const closed = readMachineSnap(writeMachineSnap({ ...snap, origin: home, trail: t, sel: t.map(() => null), focusCol: t.length - 1, scroll: {}, dragged: {} }))!;
          const o = openingOf(closed, home, null);
          expect(o.from).toBe("snapshot");
          if (o.from === "snapshot") expect(o.snap.trail).toEqual(t);
        });
  test("a request made while it was closed wins over where it was left", () => {
    const closed = readMachineSnap(writeMachineSnap({ ...snap, origin: home }))!;
    expect(openingOf(closed, home, "/srv/orbit")).toEqual({ from: "request", at: "/srv/orbit" });
  });
  test("a link that moved the place while it was closed wins over the memory", () => {
    const closed = readMachineSnap(writeMachineSnap({ ...snap, origin: home }))!;
    expect(openingOf(closed, "/srv/orbit", null)).toEqual({ from: "start", at: "/srv/orbit" });
  });
  test("nothing remembered: the palette's place", () => {
    expect(openingOf(null, home, null)).toEqual({ from: "start", at: home });
  });
});
