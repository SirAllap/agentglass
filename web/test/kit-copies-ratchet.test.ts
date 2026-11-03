/*
 * The kit's pieces are imported, not copied, and the count of copies only goes
 * down.
 *
 * An audit of the desktop UI found 87 local components playing a kit role
 * (Section x6, Field x6, Card x5, Chip x4 ...) and 345 places using them: a
 * `Btn` in one panel, a `Field` in four more, each with its own height, radius
 * and gap, so the same control drew differently from view to view. The kit has
 * all of them now (`Chip`, `Button`, `IconButton`, `Badge`, `Field`, `Section`,
 * `Card` ...), and a later lot moves a screen onto it by deleting its copy.
 *
 * Per file and per name, a copy is counted as its definition (`function Btn`,
 * `const Btn =`) plus every `<Btn` use, unless the file imports that name from
 * `workspace/Chrome` or `SettingsKit` (then it is the kit's, not a copy). The
 * ceilings are in `kit-copies.txt`; as in `surface-ratchet.test.ts` a count
 * above its line fails, and so does one below it, so the commit that migrates a
 * screen lowers the line and the room it freed cannot be spent again. A file
 * with no line has a ceiling of 0. The kit's own files are not counted.
 *
 * `KIT_COPIES_PRINT=1 bun test test/kit-copies-ratchet.test.ts` prints the
 * file to paste after a migration.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;
const NAMES = ["Btn", "IconBtn", "Chip", "Pill", "Tag", "Field", "Section", "Card", "Row", "ListRow"] as const;
const KIT_FILES = ["components/workspace/Chrome.tsx", "components/SettingsKit.tsx"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** How many times `src` defines or uses a local `name`; 0 when the name is the kit's. */
export function copies(src: string, name: string): number {
  const fromKit = new RegExp(`import\\s[^;]*\\b${name}\\b[^;]*from\\s+"[^"]*(?:workspace/Chrome|/Chrome|SettingsKit)(?:\\.tsx)?"`);
  if (fromKit.test(src)) return 0;
  const defs = src.match(new RegExp(`\\b(?:function|const) ${name}\\b`, "g"))?.length ?? 0;
  const uses = src.match(new RegExp(`<${name}(?=[\\s/>])`, "g"))?.length ?? 0;
  return defs + uses;
}

const counts = new Map<string, number>();
for (const f of sourceFiles(SRC)) {
  const rel = f.slice(SRC.length + 1);
  if (KIT_FILES.includes(rel)) continue;
  const src = stripComments(await Bun.file(f).text());
  for (const n of NAMES) {
    const c = copies(src, n);
    if (c > 0) counts.set(`${rel} ${n}`, c);
  }
}

const ceilings = new Map<string, number>(
  (await Bun.file(new URL("./kit-copies.txt", import.meta.url)).text())
    .split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => { const [file, name, n] = l.trim().split(/\s+/); return [`${file} ${name}`, Number(n)] as [string, number]; }),
);

describe("kit copies ratchet", () => {
  test("no file grows a local copy of a kit piece, and the ceilings follow the counts down", () => {
    if (process.env.KIT_COPIES_PRINT) console.log([...counts].sort().map(([k, n]) => `${k} ${n}`).join("\n"));
    const grew: string[] = [];
    const shrank: string[] = [];
    for (const [k, n] of counts) {
      const cap = ceilings.get(k) ?? 0;
      if (n > cap) grew.push(`${k}: ${n}, ceiling ${cap}. Import it from workspace/Chrome.tsx or SettingsKit.tsx instead of writing another.`);
      else if (n < cap) shrank.push(`${k}: ${n}, ceiling ${cap}: lower it in web/test/kit-copies.txt.`);
    }
    for (const [k, cap] of ceilings) if (!counts.has(k) && cap > 0) shrank.push(`${k}: 0, ceiling ${cap}: delete the line in web/test/kit-copies.txt.`);
    expect(grew).toEqual([]);
    expect(shrank).toEqual([]);
  });

  test("the counter sees a definition, a use, and the kit's own import", () => {
    // Break-it-on-purpose, kept: a pattern matching nothing would pass the file above.
    expect(copies("function Btn({ a }) {}\n<Btn onClick={x}>", "Btn")).toBe(2);
    expect(copies("const Field = ({ k }) => (\n<Field\n  k=\"a\">", "Field")).toBe(2);
    expect(copies('import { Chip, Button } from "../workspace/Chrome.tsx";\n<Chip on>', "Chip")).toBe(0);
    expect(copies('import {\n  Field,\n} from "./SettingsKit.tsx";\n<Field label="a">', "Field")).toBe(0);
    expect(copies("<ChipRow/> <Cards>", "Chip")).toBe(0);
  });
});
