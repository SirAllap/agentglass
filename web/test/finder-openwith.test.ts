/*
 * Open With in the finder: what the search keeps, and that the box hands the
 * server an entry id and nothing it could run.
 */
import { describe, expect, test } from "bun:test";
import { filterApps, menuFor } from "../src/lib/finderOps.ts";

const dialog = await Bun.file(new URL("../src/components/finder/machine/FinderDialogs.tsx", import.meta.url)).text();
const hook = await Bun.file(new URL("../src/components/finder/machine/useFinderOps.tsx", import.meta.url)).text();

const apps = [
  { id: "a.desktop", name: "Orbit Writer", comment: "Write notes" },
  { id: "b.desktop", name: "Orbit Viewer", comment: "Look at pictures" },
  { id: "c.desktop", name: "Pager", comment: "" },
];

describe("the search", () => {
  test("nothing typed keeps everything, in order", () => { expect(filterApps(apps, "  ").map((a) => a.id)).toEqual(["a.desktop", "b.desktop", "c.desktop"]); });
  test("every word must match the name or the description, whatever the case", () => {
    expect(filterApps(apps, "orbit").map((a) => a.id)).toEqual(["a.desktop", "b.desktop"]);
    expect(filterApps(apps, "ORBIT pictures").map((a) => a.id)).toEqual(["b.desktop"]);
    expect(filterApps(apps, "zzz")).toEqual([]);
  });
});

describe("the menu and the box", () => {
  test("Open With… is a real item in both menus, no longer a placeholder", () => {
    for (const t of ["file", "folder", "empty"] as const) {
      const it = menuFor(t, { count: 1, canPaste: false, hidden: false, previewable: true }).flat().find((i) => i.id === "open-with");
      expect(it).toMatchObject({ label: "Open With…" });
      expect(it!.later).toBeUndefined();
    }
  });
  test("the box sends an entry id and the files, never a command", () => {
    const body = dialog.slice(dialog.indexOf("export function OpenWithDialog("));
    expect(body).toContain("onLaunch(r.app.id");
    expect(body).not.toMatch(/exec|command|argv/i);
    expect(hook).toContain("api.openWithLaunch(id, ps");
  });
  test("Strata's words are on the box", () => {
    for (const w of ["Search applications…", "Recommended Applications", "Other Applications", "Always use for this file type", "No compatible applications were found"]) expect(dialog).toContain(w);
  });
});
