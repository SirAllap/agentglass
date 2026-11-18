import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

// House style: a native title= on a DOM tag is banned; the tooltip is TipHost's (data-tip).
// An <iframe> keeps title: there it is the frame's accessible name, not a tooltip.
const DIR = new URL("../src/components/flightPlan/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

function nativeTitles(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(/\stitle=/g)) {
    const open = src.lastIndexOf("<", m.index);
    const tag = /^<([a-zA-Z][\w.]*)/.exec(src.slice(open))?.[1] ?? "";
    if (/^[a-z]/.test(tag) && tag !== "iframe") hits.push(`${tag}@${src.slice(0, m.index).split("\n").length}`);
  }
  return hits;
}

const views: Record<string, (f: string) => boolean> = {
  Polaris: (f) => /^(Pilot|GoPoll|SettingsTab|ProjectsCard|StateBadge)/.test(f),
  "Flight plan": (f) => !views.Polaris(f),
};

for (const [view, pick] of Object.entries(views)) {
  describe(`${view}: no native title=`, () => {
    for (const f of files.filter(pick)) {
      test(f, async () => {
        expect(nativeTitles(await Bun.file(new URL(f, DIR)).text())).toEqual([]);
      });
    }
  });
}

test("the check sees a native title and skips a component prop", () => {
  expect(nativeTitles('<div className="t" title={x}>')).toEqual(["div@1"]);
  expect(nativeTitles('<PilotRow title="Budget">')).toEqual([]);
});
