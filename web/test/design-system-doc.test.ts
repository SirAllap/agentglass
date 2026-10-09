/*
 * The design system page names only what the source defines.
 *
 * `docs/design-system.md` is the canon a new view is built from, and a canon
 * that names a token the code renamed a month ago sends the next view looking
 * for something that is not there — or worse, writing it again under the old
 * name. So the page's token table is read here, row by row: the name in the
 * first column must be defined in the file the third column names, and a bare
 * number in the second column must be its value there.
 *
 * "Defined" means an `export const|function|type|class`, a module-level
 * `const` (the timeline's `TL_*` are private to the panel they lay out), or a
 * custom property declared in a stylesheet. A `--*-ink` has no declaration:
 * `inkTints` writes one per entry of `TINT_KEYS` when a theme is applied, so
 * its tint must be in that list.
 *
 * Source is read as text, per this repo's rule for a decision that is not
 * made at runtime.
 */
import { describe, expect, test } from "bun:test";

const REPO = new URL("../../", import.meta.url).pathname;
const DOC = await Bun.file(`${REPO}docs/design-system.md`).text();

type Row = { name: string; value: string; file: string };

/** The rows of the table under `## Tokens`, up to the next heading. */
export function tokenRows(doc: string): Row[] {
  const at = doc.indexOf("\n## Tokens\n");
  if (at < 0) return [];
  const rest = doc.slice(at + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 3) continue;
    const name = cells[0]!.match(/^`([^`]+)`$/)?.[1];
    const file = cells[2]!.match(/^`([^`]+)`$/)?.[1];
    if (!name || !file) continue;
    rows.push({ name, value: cells[1]!, file });
  }
  return rows;
}

const rows = tokenRows(DOC);
const sources = new Map(
  await Promise.all([...new Set(rows.map((r) => r.file))].map(async (f) => [f, await Bun.file(`${REPO}${f}`).text()] as const)),
);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `name` is defined in `src`, and the defining line if it is. */
export function definition(name: string, src: string): string | null {
  if (name.startsWith("--")) {
    const ink = name.match(/^(--[a-z]+)-ink$/);
    if (ink) {
      const keys = src.match(/export const TINT_KEYS = \[([^\]]*)\]/)?.[1] ?? "";
      return keys.includes(`"${ink[1]}"`) ? `TINT_KEYS ${keys}` : null;
    }
    return src.match(new RegExp(`^[ \\t]*${esc(name)}:[^;]*;`, "m"))?.[0] ?? null;
  }
  return src.match(new RegExp(`^(?:export )?(?:const|function|type|class) ${esc(name)}\\b[^\\n]*`, "m"))?.[0] ?? null;
}

describe("the design system page", () => {
  test("has a token table to check", () => {
    // A heading renamed or a column added must not turn this into a loop over
    // nothing that passes.
    expect(rows.length).toBeGreaterThan(30);
  });

  test("names only files that exist", () => {
    const missing = [...new Set(rows.map((r) => r.file))].filter((f) => !sources.get(f));
    expect(missing).toEqual([]);
  });

  test("names only tokens the named file defines", () => {
    const missing = rows.filter((r) => definition(r.name, sources.get(r.file) ?? "") === null)
      .map((r) => `${r.name} in ${r.file}`);
    expect(missing).toEqual([]);
  });

  test("gives a bare number only where it is the value in source", () => {
    const wrong = rows.filter((r) => /^\d+$/.test(r.value)).filter((r) => {
      const line = definition(r.name, sources.get(r.file) ?? "") ?? "";
      return !new RegExp(`=\\s*${r.value}\\s*;`).test(line);
    }).map((r) => `${r.name} = ${r.value}`);
    expect(wrong).toEqual([]);
  });

  test("the check tells a real name from a made-up one", () => {
    const chrome = sources.get("web/src/components/workspace/Chrome.tsx") ?? "";
    const css = sources.get("web/src/index.css") ?? "";
    const contrast = sources.get("web/src/lib/contrast.ts") ?? "";
    expect(definition("Button", chrome)).not.toBeNull();
    expect(definition("Buttonish", chrome)).toBeNull();
    expect(definition("--surface-card", css)).not.toBeNull();
    // Used all over the app, declared nowhere: a `var()` is not a definition.
    expect(definition("--font-mono", css)).toBeNull();
    expect(definition("--error-ink", contrast)).not.toBeNull();
    expect(definition("--graph-ink", contrast)).toBeNull();
  });
});
