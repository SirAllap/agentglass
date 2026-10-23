/*
 * The Machine finder has no search box on top. A typed path is the path bar, a
 * search inside one folder is a column's filter, and a search across the disk is
 * the Ctrl+K overlay. This fails the build if the box comes back on that tab.
 */
import { describe, expect, test } from "bun:test";

const strip = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
const palette = strip(await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text());
const machine = strip(await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text());

describe("no search box on the Machine tab", () => {
  test("the top bar, with its field, only renders off the Machine tab", () => {
    const at = palette.indexOf("<input ref={inputRef} data-finder-box");
    expect(at).toBeGreaterThan(0);
    const before = palette.slice(0, at);
    expect(before.lastIndexOf('{tab !== "machine" && (')).toBeGreaterThan(before.lastIndexOf("<Portal"));
  });
  test("the field is the only one with the box marker, and it is not in the finder", () => {
    expect(palette.match(/data-finder-box/g)?.length).toBe(1);
    expect(machine).not.toContain("data-finder-box value");
  });
  test("the finder is on whenever the tab is Machine and home is known, whatever is in q", () => {
    expect(palette).toMatch(/const finderOn = tab === "machine" && !!homeDir && !placeErr;/);
  });
  test("close lives on the path-bar row", () => {
    const row = machine.slice(machine.indexOf("<FinderPathBar"));
    expect(row.slice(0, row.indexOf("</div>"))).toContain("<CloseButton onClick={onClose}");
  });
  test("the panel takes the keys when there is no field to hold them", () => {
    expect(palette).toContain("panelRef.current?.focus()");
    expect(machine).toContain("t === panel");
  });
});
