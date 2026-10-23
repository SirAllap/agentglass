import { describe, expect, test } from "bun:test";
import { pinLabel, pinnedOnly, placesFor } from "../src/components/finder/machine/Sidebar.tsx";
import type { DiskPlace, PinnedPlace } from "../../shared/types.ts";

// The shape of a real GTK bookmarks file, as the server hands it over: XDG folders, one project folder, one remote.
const HOME = "/home/ann";
const PINS: PinnedPlace[] = [
  { uri: "file:///home/ann/Documents/projects", label: "projects", path: "/home/ann/Documents/projects" },
  { uri: "file:///home/ann/Documents", label: "Documents", path: "/home/ann/Documents" },
  { uri: "file:///home/ann/Downloads", label: "Downloads", path: "/home/ann/Downloads" },
  { uri: "file:///home/ann/Pictures", label: "Pictures", path: "/home/ann/Pictures" },
  { uri: "file:///home/ann/Videos", label: "Videos", path: "/home/ann/Videos" },
  { uri: "sftp://ann@10.0.0.7/home/ann", label: "Workstation" },
];
const known: DiskPlace[] = ["Documents", "Downloads", "Music", "Pictures", "Videos"].map((n) => ({ path: `${HOME}/${n}`, label: n }));

describe("the sidebar as Strata lists it", () => {
  test("the top section has every XDG folder that exists", () => {
    expect(placesFor(HOME, known).map((p) => p.label)).toEqual(["Home", "Trash", "Network", "Recent", "Documents", "Downloads", "Music", "Pictures", "Videos"]);
  });
  test("pinned is only what the top section does not already show", () => {
    expect(pinnedOnly(PINS, placesFor(HOME, known)).map((b) => b.label)).toEqual(["projects", "Workstation"]);
  });
  test("a bookmark of a folder that does not exist at the top stays pinned", () => {
    expect(pinnedOnly(PINS, placesFor(HOME, [])).map((b) => b.label)).toEqual(["projects", "Workstation"]);
    expect(pinnedOnly([{ uri: "file:///home/ann/Desktop", label: "Desktop", path: "/home/ann/Desktop" }], placesFor(HOME, known)).length).toBe(1);
  });
});

const side = await Bun.file(new URL("../src/components/finder/machine/Sidebar.tsx", import.meta.url)).text();
const disk = await Bun.file(new URL("../../server/src/disk.ts", import.meta.url)).text();
test("every pinned row wears the plain folder icon, the remote too", () => {
  const at = side.indexOf("const remote = (b: PinnedPlace)");
  expect(side.slice(at, side.indexOf("</button>", at))).toContain('name="folder"');
});
test("the server offers Music, Pictures and Videos as places when they exist", () => {
  const line = disk.slice(disk.indexOf("const HOME_FOLDERS"), disk.indexOf("];", disk.indexOf("const HOME_FOLDERS")));
  for (const n of ["Music", "Pictures", "Videos"]) expect(line).toContain(`"${n}"`);
});

describe("a pinned row's label", () => {
  test("is the bookmark's own label, the folder name only without one", () => {
    expect(pinLabel({ uri: "file:///h/pin", label: "Pinned Local", path: "/h/pin" })).toBe("Pinned Local");
    expect(pinLabel({ uri: "file:///h/pin", label: " ", path: "/h/pin" })).toBe("pin");
  });
});
