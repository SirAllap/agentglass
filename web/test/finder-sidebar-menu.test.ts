import { describe, expect, test } from "bun:test";
import { sideMenu, visiblePlaces, withHidden } from "../src/lib/finderSidebarMenu.ts";
import type { Volume } from "../../shared/types.ts";

const labels = (t: Parameters<typeof sideMenu>[0]) => sideMenu(t).map((i) => i.label);
const vol = (o: Partial<Volume>): Volume => ({ id: "/dev/sdb1", name: "backup", encrypted: false, locked: false, mounted: true, mountPoint: "/run/media/ann/backup", release: "eject", ...o } as Volume);

describe("the menu of a sidebar row, as Strata builds it", () => {
  test("Home, an XDG folder and a pinned folder: Unpin, Customize, Properties", () => {
    expect(labels({ kind: "place", id: "home", path: "/home/ann" })).toEqual(["Unpin", "Customize…", "Properties"]);
    expect(labels({ kind: "place", id: "Documents", path: "/home/ann/Documents" })).toEqual(["Unpin", "Customize…", "Properties"]);
    expect(labels({ kind: "pin", uri: "file:///home/ann/orbit", path: "/home/ann/orbit" })).toEqual(["Unpin", "Customize…", "Properties"]);
  });
  test("Trash, Network and Recent only unpin (a right-click on Recent opened nothing)", () => {
    expect(labels({ kind: "place", id: "trash" })).toEqual(["Unpin"]);
    expect(labels({ kind: "place", id: "network" })).toEqual(["Unpin"]);
    expect(labels({ kind: "place", id: "recent", path: "recent://" })).toEqual(["Unpin"]);
  });
  test("a pinned remote only unpins", () => {
    expect(labels({ kind: "pin", uri: "sftp://ann@10.0.0.7/home/ann" })).toEqual(["Unpin"]);
  });
  test("a removable drive: Eject, then Properties; an unmounted one offers Mount", () => {
    expect(labels({ kind: "device", volume: vol({}) })).toEqual(["Eject", "Properties"]);
    expect(labels({ kind: "device", volume: vol({ mounted: false, mountPoint: undefined, release: "unmount" }) })).toEqual(["Mount"]);
  });
  test("an encrypted drive leads with Unlock or Lock", () => {
    expect(labels({ kind: "device", volume: vol({ encrypted: true, locked: true, mounted: false, mountPoint: undefined, release: "eject" }) })).toEqual(["Unlock", "Eject"]);
    expect(labels({ kind: "device", volume: vol({ encrypted: true }) })).toEqual(["Lock", "Eject", "Properties"]);
  });
  test("a mounted share: Properties, then Disconnect in the danger colour", () => {
    const m = sideMenu({ kind: "device", volume: vol({ remote: "smb" }) });
    expect(m.map((i) => i.label)).toEqual(["Properties", "Disconnect"]);
    expect(m[1]!.danger).toBe(true);
  });
});

describe("a place hidden with Unpin", () => {
  const places = [{ id: "home" }, { id: "trash" }, { id: "Documents" }];
  test("is left out, and comes back when its switch is turned on", () => {
    expect(visiblePlaces(places, ["trash"]).map((p) => p.id)).toEqual(["home", "Documents"]);
    expect(withHidden(["trash"], "Documents", true)).toEqual(["trash", "Documents"]);
    expect(withHidden(["trash", "Documents"], "trash", false)).toEqual(["Documents"]);
    expect(withHidden(["trash"], "trash", true)).toEqual(["trash"]);
  });
});

import { ROWS } from "../src/lib/finderSettingsModel.ts";
import { DEFAULT_PREFS, readPrefs, writePrefs } from "../src/lib/finderMiller.ts";
const dir = new URL("../src/components/finder/machine/", import.meta.url);
const sidebar = await Bun.file(new URL("Sidebar.tsx", dir)).text();
const finder = await Bun.file(new URL("MachineFinder.tsx", dir)).text();

describe("every sidebar row has its menu", () => {
  test("the place (and pinned folder) and device rows spread the same handlers; a pinned remote is inert and has no menu", () => {
    expect(sidebar.match(/\{\.\.\.menuOf\(/g)?.length).toBe(2);
    const at = sidebar.indexOf("const remote = (");
    expect(sidebar.slice(at, sidebar.indexOf("const device = (", at))).toContain("disabled");
  });
  test("the Menu key and Shift+F10 open it at the row", () => {
    const at = sidebar.indexOf("const menuOf = (");
    const body = sidebar.slice(at, sidebar.indexOf("  const row = (", at));
    expect(body).toContain('"ContextMenu"');
    expect(body).toContain('"F10" && e.shiftKey');
    expect(body).toContain("getBoundingClientRect()");
  });
  test("the finder carries out every act the menu names", () => {
    const at = finder.indexOf("const onSideAct = (");
    const body = finder.slice(at, finder.indexOf("\n  };", at));
    for (const k of ["togglePinned(", "removePinned(", "ops.openCustomize(", "ops.openProps(", "devices.onVolumeAct("]) expect(body).toContain(k);
  });
});

describe("Unpin on a place hides it until Settings turns it back on", () => {
  test("Settings has Strata's ten switches, in its own words", () => {
    const rows = ROWS.filter((r) => r.kind === "place");
    expect(rows.length).toBe(10);
    expect(rows[0]!.title).toBe("Show Home in sidebar");
    expect(new Set(rows.map((r) => r.section))).toEqual(new Set(["Items shown in sidebar"]));
  });
  test("the hidden ones are remembered, and a damaged value is nothing hidden", () => {
    expect(readPrefs(writePrefs({ ...DEFAULT_PREFS, hiddenPlaces: ["trash"] })).hiddenPlaces).toEqual(["trash"]);
    expect(readPrefs('{"hiddenPlaces":"trash"}').hiddenPlaces).toEqual([]);
    expect(readPrefs(null).hiddenPlaces).toEqual([]);
  });
});
