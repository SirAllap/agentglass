import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* A row on a Settings page is a label, a help line and a control or a link. A row with none of them is a fact
   with nowhere to go: it belongs on Inspect (kind="fact") or is a status line, not a row. */
const PAGES = join(import.meta.dir, "..", "src", "components", "settings", "pages");
const files = readdirSync(PAGES).filter((f) => f.endsWith(".tsx")).sort();

/** The attribute text of every `<SettingRow …>` tag in a source, scanning past `{…}` so a `>` inside an arrow does not end the tag. */
export function rowTags(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/<SettingRow\b/g)) {
    let i = m.index! + m[0].length, depth = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && code[i - 1] !== "=") break;
    }
    out.push(code.slice(m.index! + m[0].length, i));
  }
  return out;
}

/** What a row of that kind must carry to have a control or a link. */
export function missing(tag: string): string | null {
  // `{...(reason ? { kind: "locked", reason } : { kind: "control" })}` picks its kind at run time: it still needs a control.
  if (/\{\.\.\./.test(tag) && /\bkind:/.test(tag)) return /\bcontrol=/.test(tag) ? null : "no control";
  const kind = /\bkind=(?:"(\w+)"|\{[^}]*\})/.exec(tag);
  if (!kind) return "no kind";
  if (!kind[1]) return null; // a kind picked at run time is one of the four, checked by the type
  if (kind[1] === "control" || kind[1] === "locked") return /\bcontrol=/.test(tag) ? null : "no control";
  if (kind[1] === "link") return /\b(onOpen|href)=/.test(tag) ? null : "no link target";
  if (kind[1] === "fact") return /\bonCopy=/.test(tag) ? null : "a fact without Copy";
  return `unknown kind ${kind[1]}`;
}

describe("every row on a Settings page has a control or a link", () => {
  test("the check goes red on a row with neither", () => {
    expect(missing('kind="control" label="A" help="B."')).toBe("no control");
    expect(missing('label="A" help="B."')).toBe("no kind");
    expect(missing('kind="link" label="A" linkText="Open"')).toBe("no link target");
    expect(missing('kind="link" label="A" onOpen={go}')).toBeNull();
    expect(missing('{...(r ? { kind: "locked" } : { kind: "control" })} label="A"')).toBe("no control");
    expect(rowTags("<SettingRow kind=\"control\" control={<button onClick={() => x}>Go</button>} />")).toHaveLength(1);
  });
  test("the scan sees the rows", () => {
    expect(files.reduce((n, f) => n + rowTags(readFileSync(join(PAGES, f), "utf8")).length, 0)).toBeGreaterThan(100);
  });
  for (const f of files) {
    test(f, () => {
      for (const tag of rowTags(readFileSync(join(PAGES, f), "utf8"))) {
        expect({ file: f, row: tag.slice(0, 70).replace(/\s+/g, " "), problem: missing(tag) }).toEqual({ file: f, row: tag.slice(0, 70).replace(/\s+/g, " "), problem: null });
      }
    });
  }
  test("no page builds a row from the old row, which may have neither", () => {
    for (const f of files) {
      const code = readFileSync(join(PAGES, f), "utf8");
      expect({ f, old: /import \{[^}]*\bSettingRow\b[^}]*\} from "\.\.\/\.\.\/SettingRow\.tsx"/.test(code) }).toEqual({ f, old: false });
    }
  });
});
