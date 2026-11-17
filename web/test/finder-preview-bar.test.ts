import { describe, expect, test } from "bun:test";

const dir = "../src/components/finder/machine/";
const bar = await Bun.file(new URL(dir + "PreviewBar.tsx", import.meta.url)).text();
const body = await Bun.file(new URL(dir + "PreviewBody.tsx", import.meta.url)).text();
const quick = await Bun.file(new URL(dir + "QuickLook.tsx", import.meta.url)).text();
const link = await Bun.file(new URL("../src/lib/pageLink.ts", import.meta.url)).text();

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

describe("open in browser: a page's scripts are a choice, off by default", () => {
  test("the press opens without scripts; only the menu item asks for them", () => {
    expect(quick).toContain("onBrowser: offersBrowser(row.name, row.locked) ? () => { void openFileInBrowser(path).then(");
    expect(quick).toContain("onBrowserScripts: offersBrowser(row.name, row.locked) && offersScripts(row.name) ? () => { void openFileInBrowser(path, true).then(");
    expect(link).toContain("export async function openFileInBrowser(abs: string, scripts = false)");
  });
  test("the split button's item says what scripts can do", () => {
    expect(bar).toContain('export const SCRIPTS_HELP = "Its scripts can send this page\'s contents to any site.";');
    expect(bar).toContain("<span>Open with its scripts</span>");
    expect(bar).toContain("onClick={() => { close(); onBrowserScripts(); }}");
    expect(bar).toContain('label="Open in browser, scripts off" onClick={onBrowser}');
  });
});
