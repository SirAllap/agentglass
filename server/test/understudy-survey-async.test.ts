/*
 * `GET /understudy/sources` surveys with listSourcesAsync so the loop stays
 * free; `allowedSources` still uses listSources. The consent screen and the
 * reader must agree on what a source holds, so the two give the same rows,
 * cap included. Past the 20,000-file cap the total depends on walk order: a
 * walk that counts a folder's own files before its subfolders skips a/ here
 * and says 20,001 where the sync walk says 25,001.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { listSources, listSourcesAsync } = await import("../src/understudy-sources.ts");

const box = mkdtempSync(join(tmpdir(), "agx-survey-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));

// a/ sorts ahead of the root's own files (r00000.md...).
const capped = join(box, "capped");
mkdirSync(join(capped, "a"), { recursive: true });
for (let i = 0; i < 5_000; i++) writeFileSync(join(capped, "a", `n${i}.md`), "x");
for (let i = 0; i <= 20_000; i++) writeFileSync(join(capped, `r${String(i).padStart(5, "0")}.md`), "yy");

const nested = join(box, "nested");
mkdirSync(join(nested, "b", "c"), { recursive: true });
writeFileSync(join(nested, "top.md"), "one");
writeFileSync(join(nested, "b", "mid.json"), "{}");
writeFileSync(join(nested, "b", "c", "deep.txt"), "deep");
writeFileSync(join(nested, "b", "skip.bin"), "no");

const extra = [
  { id: "extra:capped", path: capped },
  { id: "extra:nested", path: nested },
];
const ours = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith("extra:"));

describe("listSourcesAsync answers what listSources answers", () => {
  test("same rows and totals, past the 20,000-file cap too", async () => {
    const sync = ours(listSources({}, extra));
    const async_ = ours(await listSourcesAsync({}, extra));
    expect(async_).toEqual(sync);
    const capRow = sync.find((r) => r.id === "extra:capped")!;
    expect(capRow.files).toBe(25_001);
    expect(capRow.bytes).toBe(5_000 + 20_001 * 2);
    expect(sync.find((r) => r.id === "extra:nested")!.files).toBe(3);
  }, 30_000);
});
