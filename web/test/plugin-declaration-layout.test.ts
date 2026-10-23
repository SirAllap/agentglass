/*
 * The "What it can do" block and the dialog that asks about it.
 *
 * A plugin that reads eleven paths drew eleven lines in one column, the dialog
 * grew taller than a small window and its approve button was off the screen,
 * and the card kept the same block open behind the dialog. Asserted against
 * source and the pure grouping, as there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import { CHIP_FOLD, foldChips, homeShort, sandboxSections } from "../src/lib/pluginDeclarationLayout.ts";

const DECL = await Bun.file(new URL("../src/components/plugins/PluginDeclaration.tsx", import.meta.url)).text();
const PANE = await Bun.file(new URL("../src/components/PluginsPane.tsx", import.meta.url)).text();
const DIALOG = await Bun.file(new URL("../src/components/ConfirmDialog.tsx", import.meta.url)).text();
const CSS = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

const grants = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/home/me/.config/acme/dir${i}`, secret: null as string | null }));
const sandbox = { internet: true, reads: grants(11), writes: [], programs: ["git", "gh", "bun", "node", "rg"] };

describe("sandbox sections", () => {
  test("network first, then reads, writes, programs; empty ones left out", () => {
    expect(sandboxSections(sandbox, "/home/me").map((s) => s.key)).toEqual(["network", "reads", "programs"]);
    expect(sandboxSections({ ...sandbox, writes: grants(1) }, "/home/me").map((s) => s.key)).toEqual(["network", "reads", "writes", "programs"]);
    expect(sandboxSections({ internet: false, reads: [], writes: [], programs: [] })[0]).toMatchObject({ key: "network", value: "this app only", warn: false });
  });
  test("home is ~, and a secret-looking path goes first so the fold cannot hide it", () => {
    const secs = sandboxSections({ ...sandbox, reads: [...grants(10), { path: "/home/me/.ssh", secret: "ssh keys" }] }, "/home/me");
    const reads = secs.find((s) => s.key === "reads")!.chips!;
    expect(reads[0]).toEqual({ text: "~/.ssh", secret: "ssh keys" });
    expect(reads[1]!.text).toBe("~/.config/acme/dir0");
    expect(homeShort("/home/other/x")).toBe("~/x");
    expect(homeShort("/etc/hosts", "/home/me")).toBe("/etc/hosts");
  });
});

describe("chip folding", () => {
  test("eight or fewer show whole; eleven show eight and hide three", () => {
    expect(CHIP_FOLD).toBe(8);
    expect(foldChips(grants(8), false)).toMatchObject({ hidden: 0 });
    const f = foldChips(grants(11), false);
    expect(f.shown).toHaveLength(8);
    expect(f.hidden).toBe(3);
  });
  test("Show all reveals every one", () => {
    expect(foldChips(grants(11), true)).toMatchObject({ hidden: 0, shown: expect.any(Array) });
    expect(foldChips(grants(11), true).shown).toHaveLength(11);
  });
  test("the component draws '+n more' and 'Show all' from it", () => {
    expect(DECL).toContain("foldChips(chips, all)");
    expect(DECL).toMatch(/\+\{hidden\} more · Show all/);
  });
});

describe("one declaration per place", () => {
  test("rendered once in the card and once as the approval dialog body, through one component", () => {
    expect((PANE.match(/<PluginDeclaration /g) ?? []).length).toBe(2);
    expect(PANE).toContain("<PluginDeclaration plugin={plugin} flat />");
    expect(PANE).toContain("node: <PluginDeclaration plugin={plugin} />");
  });
  test("the card's disclosure is closed by default, so it is not open behind the dialog", () => {
    expect(PANE).toContain('<details className="agx-perm ');
    expect(PANE).not.toMatch(/<details className="agx-perm[^>]* open[ >=]/);
  });
  test("the grid collapses by container width, and the card body is full width", () => {
    expect(CSS).toMatch(/@container agx-decl \(min-width: \d+px\) \{[^}]*\.agx-decl-row \{ grid-template-columns: 80px/);
    expect(CSS).toMatch(/\.agx-disclosure-b\.agx-wide \{ max-width: none; \}/);
  });
});

describe("dialog structure", () => {
  const panel = DIALOG.slice(DIALOG.indexOf('role="dialog"'), DIALOG.indexOf("</Portal>"));
  test("the panel is capped to the viewport minus its margin and lays out as a column", () => {
    expect(DIALOG).toMatch(/maxHeight: "calc\(100dvh - 48px\)"/);
    expect(DIALOG).toMatch(/flex flex-col/);
  });
  test("the footer is outside the scroll container and cannot shrink; only the body scrolls", () => {
    const body = panel.indexOf("agx-dialog-body");
    const footer = panel.indexOf('borderTop: LINE');
    expect(body).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(body);
    expect(panel.slice(body, footer)).toContain("overflow-y-auto");
    expect(panel.slice(footer - 200, footer)).toContain("shrink-0");
    expect(panel.slice(footer)).not.toContain("overflow-y-auto");
    expect(panel.slice(0, body)).toContain("shrink-0");
  });
  test("the body is a Tab stop and has a slim bar and edge shade", () => {
    expect(panel).toMatch(/agx-dialog-body[^>]*tabIndex=\{0\}/);
    expect(CSS).toMatch(/\.agx-dialog-body \{[^}]*scrollbar-width: thin/);
    expect(CSS).toMatch(/\.agx-dialog-body \{[^}]*local[^}]*scroll;/);
  });
  test("focus lands on confirm unless Cancel or the field should take it", () => {
    expect(DIALOG).toMatch(/cancelRef\.current\?\.focus\(\); else if \(!pending\.input\) confirmRef\.current\?\.focus\(\)/);
    expect(DIALOG).toContain("ref={confirmRef}");
  });
});
