// The synchronous database work that used to run unlabelled.
//
// A stall is filed under the last label entered, so work with no label of its
// own was filed under whichever request happened to be near it ("GET
// /gate/pending", a cheap Map read, was blamed for 3.4 s). These paths each
// block the loop on a database of about a gigabyte, so each names itself.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");

describe("database work names itself to the loop watch", () => {
  const cases: [string, string][] = [
    ["index.ts", 'waitedFor("retention prune"'],
    ["index.ts", 'waitedFor("wal checkpoint"'],
    ["db.ts", 'waitedFor("vacuum"'],
    ["clickupindex.ts", 'waitedFor("clickup index write"'],
    ["clickupindex.ts", 'waitedFor("clickup index search"'],
    ["clickupindex.ts", 'waitedFor("clickup index body scan"'],
    ["clickupindex.ts", 'waitedFor("clickup index evict"'],
    ["understudy.ts", 'waitedFor("understudy baselines scan"'],
  ];
  for (const [file, label] of cases) {
    it(`${file} labels ${label}`, () => expect(src(file)).toContain(label));
  }
});
