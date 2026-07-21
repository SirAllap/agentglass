import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Source files must stay searchable.
 *
 * Three files used a raw NUL (and a raw SOH/STX) as a field separator, written
 * as literal bytes rather than escapes. grep and ripgrep classify any file
 * containing them as binary and then report *no matches with no error*, so a
 * recursive search over the tree silently skipped them.
 *
 * That is not a cosmetic problem. `web/src/App.tsx` is the file most likely to
 * answer "where is this component mounted", and while investigating #135 a
 * search across web/src/ came back empty and led to the conclusion that the
 * gate approval UI did not exist anywhere in the app. It did, at App.tsx:467.
 * `server/src/notifications.ts` was skipped the same way in the same session.
 * A silent no-match is indistinguishable from a genuine absence.
 *
 * The escapes are byte-identical at runtime, so there is never a reason to
 * commit the raw character. This test keeps it that way.
 */

const ROOTS = ["web/src", "server/src", "shared", "electron", "hooks", "scripts"];
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css", ".html", ".py", ".sh"];

/** Tab, newline and carriage return are the only control characters that
 *  belong in source. Everything else below 0x20 makes the file "binary". */
const offending = (buf: Buffer): number[] => {
  const out: number[] = [];
  for (const b of buf) if (b < 0x09 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f)) out.push(b);
  return out;
};

function walk(dir: string, hits: string[]) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) { walk(p, hits); continue; }
    if (!EXTS.some((e) => name.endsWith(e))) continue;
    const bad = offending(readFileSync(p));
    if (bad.length) {
      const codes = [...new Set(bad)].map((b) => `U+${b.toString(16).toUpperCase().padStart(4, "0")}`);
      hits.push(`${p} (${bad.length}x ${codes.join(", ")})`);
    }
  }
}

test("no source file contains a raw control character that would hide it from grep", () => {
  const root = new URL("../..", import.meta.url).pathname;
  const hits: string[] = [];
  for (const r of ROOTS) walk(join(root, r), hits);

  // Written out in full: the whole point is that the failure names the file,
  // since the symptom otherwise is a search that quietly finds nothing.
  expect(hits).toEqual([]);
});
