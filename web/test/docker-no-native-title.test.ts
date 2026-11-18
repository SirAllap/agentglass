/*
 * The Docker view hands every hint to the house tooltip (TipHost, via data-tip).
 * A native title is a different box on every platform and sits over the dark
 * card, so no DOM tag in this view may carry one. Components (Button,
 * IconButton, Badge…) still take a `title` prop and turn it into data-tip
 * themselves; only lowercase tags are checked. No DOM under bun test, so this
 * reads the source.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../src/components/", import.meta.url);
const files = [
  ...readdirSync(new URL("docker" + "/", root)).filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => "docker" + "/" + f),
  "DockerPanel.tsx", "CleanupDockerLeftovers.tsx",
];

/** Every `title=` whose nearest opening tag is a DOM tag (lowercase) or the `El` stand-in for one. */
function nativeTitles(src: string): number[] {
  const out: number[] = [];
  for (const m of src.matchAll(/\btitle=[{"']/g)) {
    const at = m.index ?? 0;
    const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(src.lastIndexOf("<", at)))?.[1];
    if (tag && (/^[a-z]/.test(tag) || tag === "El")) out.push(src.slice(0, at).split("\n").length);
  }
  return out;
}

test("no DOM tag in the Docker view carries a native title", () => {
  const left = files.flatMap((f) => nativeTitles(readFileSync(new URL(f, root), "utf8")).map((line) => `${f}:${line}`));
  expect(left).toEqual([]);
});

test("the check sees a native title when there is one", () => {
  expect(nativeTitles('<span className="x" title={k}>')).toEqual([1]);
  expect(nativeTitles('<Button title="Refresh">')).toEqual([]);
});
