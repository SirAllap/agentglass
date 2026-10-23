/*
 * It is the finder, at every level a person or an agent reads: the header
 * button, titles, tooltips, the shortcut list, the ui door, the docs and the
 * skills. Internal file and storage names (FilePalette.tsx, `files.palette`,
 * `agentglass.files.palette*`) stay: renaming them would lose a saved chord and
 * a remembered folder. This fails if the old name creeps back into prose.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git", "mobile", "test", "CHANGELOG.md"]);
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|md|js)$/.test(f)) out.push(p);
  }
  return out;
};
const files = ["web/src", "shared", "server/src", "scripts", "docs", "skills", "electron"].flatMap((d) => walk(join(root, d)))
  .concat(["README.md", "CONTRIBUTING.md", "SECURITY.md"].map((f) => join(root, f)));

describe("the finder is called the finder", () => {
  test("no prose says 'file palette' or 'Find a file' (the Files view's own search box is another thing)", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith("web/src/components/FilesPanel.tsx")) continue;
      readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (/file palette|Find a file/i.test(l)) bad.push(`${f.slice(root.length)}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });
  test("the header button and the shortcut list say Finder", async () => {
    const top = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();
    const keys = await Bun.file(new URL("../src/lib/keybindings.ts", import.meta.url)).text();
    expect(top).toContain("title={`Finder (");
    expect(keys).toMatch(/"files\.palette": \{\s*label: "Finder"/);
  });
  test("the old chord id still resolves, so a saved binding and an agent keep working", async () => {
    const keys = await Bun.file(new URL("../src/lib/keybindings.ts", import.meta.url)).text();
    expect(keys).toContain('"files.palette": "mod+shift+p"');
    const ui = await Bun.file(new URL("../../shared/uiActions.ts", import.meta.url)).text();
    expect(ui).toContain('chords: ["files.palette"]');
    expect(ui).toContain('legacy: { cmd: "open", pin: { what: "finder" } }');
  });
});
