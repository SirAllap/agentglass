/*
 * Which portal is on top.
 *
 * This is here because the wrong answer shipped once and looked right in the
 * source the whole time. Portal puts its z-index on the CONTAINER it appends to
 * <body>, so a palette whose panel says `zIndex: 10001` inside a container at
 * 9999 renders UNDERNEATH a viewer whose container is 10020 — and the numbers
 * on the panels, which is where you look, say the opposite.
 *
 * Caught by a CDP probe on the rendered page, not by reading. This test is the
 * cheap half of that measurement: it cannot see the screen, but it can see the
 * one comparison that decides it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { LAYER } from "../src/lib/layers.ts";

describe("stacking", () => {
  it("keeps the palette above the viewer it raises", () => {
    // The palette stays open when it opens a document, so the next result is a
    // keystroke rather than another search. Below the viewer, opening a result
    // buries the list that produced it.
    expect(LAYER.palette).toBeGreaterThan(LAYER.viewer);
  });

  it("leaves room to slide something between them", () => {
    // Adjacent numbers mean the next layer has to renumber one of these, and
    // renumbering a stacking order is how you get a regression nobody sees
    // until it is on screen.
    expect(LAYER.palette - LAYER.viewer).toBeGreaterThanOrEqual(10);
  });

  it("keeps a menu above the panel it was opened from", () => {
    // A dropdown that opens from inside the palette has to escape it, and a
    // portal only helps if it is also drawn above.
    expect(LAYER.menu).toBeGreaterThan(LAYER.palette);
  });

  it("keeps a menu above every sheet, not just the palette", () => {
    // Select took Portal's default and was on top only because its container
    // is appended when it opens. Numbering a sheet ends that: Settings at its
    // own layer with the menu below would bury every dropdown in Settings,
    // which is the reported bug one floor up.
    //
    // The alarm is the one exception, and it is not a sheet: every other layer
    // here appears because you opened it and can wait behind whatever you
    // opened next. An alarm is a promise made at a particular minute, and one
    // that opens under the menu you happen to have down is a promise quietly
    // broken.
    const sheets = Object.entries(LAYER).filter(([k]) => k !== "alarm").map(([, z]) => z);
    for (const z of sheets) expect(LAYER.menu).toBeGreaterThanOrEqual(z);
    expect(LAYER.alarm).toBeGreaterThan(LAYER.menu);
  });

  it("puts Settings above the catalog it can be opened over", () => {
    // The reported failure: the explorer was numbered and Settings was not, so
    // the gear mounted Settings UNDERNEATH it — two scrims, the catalog still
    // on top, and to the person clicking the gear the app simply went black.
    expect(LAYER.settings).toBeGreaterThan(LAYER.catalog);
  });

  it("sits above Portal's own default, so an unnumbered portal cannot cover either", () => {
    // Portal defaults to 9999 and most callers take it.
    for (const z of Object.values(LAYER)) expect(z).toBeGreaterThan(9999);
  });

  it("gives every layer a number of its own", () => {
    // Two entries sharing a number is the same thing as neither having one:
    // which wins goes back to the order the effects appended the containers,
    // and that is the failure this whole file exists to take out of play.
    const zs = Object.values(LAYER);
    expect(new Set(zs).size).toBe(zs.length);
  });
});

describe("the components that carry the numbers", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("no sheet or menu is left on Portal's default", () => {
    // This is the half a number cannot check: layers.ts can be perfectly
    // ordered while a component still takes the default and lands wherever
    // mount order puts it — which is precisely what SettingsModal did.
    for (const [file, layer] of [
      ["../src/components/SettingsModal.tsx", "LAYER.settings"],
      ["../src/components/SkillsModal.tsx", "LAYER.catalog"],
      ["../src/components/Select.tsx", "LAYER.menu"],
    ] as const) {
      /* The prop, not the exact tag: a portal may carry others — `find`, which
         says this surface is what "find on this screen" means while it is open
         — and pinning the whole tag made adding one look like a layering bug. */
      expect(read(file), `${file} must say which layer it is on`).toMatch(new RegExp(`<Portal[^>]*\\bz=\\{${layer.replace(".", "\\.")}\\}`));
    }
  });

  it("keeps the numbers in one file", () => {
    // A literal here is a number that cannot be compared with the others, and
    // the comparison is the only thing that decides what covers what.
    expect(read("../src/components/SkillsModal.tsx")).not.toContain("z={10100}");
  });
});
