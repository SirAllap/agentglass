import { describe, expect, test } from "bun:test";

const dir = "../src/components/finder/machine/";
const bar = await Bun.file(new URL(dir + "PreviewBar.tsx", import.meta.url)).text();
const body = await Bun.file(new URL(dir + "PreviewBody.tsx", import.meta.url)).text();
const quick = await Bun.file(new URL(dir + "QuickLook.tsx", import.meta.url)).text();

describe("the preview header is Strata's", () => {
  test("the bar carries open, print and a close that names its key, in that order", () => {
    const at = (s: string) => bar.indexOf(s);
    expect(at('label="Open in the default application"')).toBeGreaterThan(-1);
    expect(at('label="Print"')).toBeGreaterThan(at('label="Open in the default application"'));
    expect(at('label="Close preview (Space)"')).toBeGreaterThan(at("{afterPrint}"));
    expect(at("{afterPrint}")).toBeGreaterThan(at('label="Print"'));
  });
  test("view tools sit in the bar: source toggle, find, wrap; no pill row for two views", () => {
    for (const icon of ['icon="file-code"', 'icon="search"', 'icon="wrap-text"']) expect(body).toContain(icon);
    expect(body).toContain("plan.tabs.length === 2");
    expect(body).not.toContain(">Find</button>");
  });
  test("the panel header no longer carries Copy path, Reveal or a second Open", () => {
    for (const gone of ["Copy path", "RevealButton", "Terminal here</button>"]) expect(quick).not.toContain(gone);
  });
});
