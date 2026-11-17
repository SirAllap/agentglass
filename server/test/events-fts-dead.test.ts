// The old full-text index of events held 58 MB under 7 rows nobody could
// reach: nothing writes or searches it any more. It is emptied at boot, and
// this pins both halves: that it empties, and that nothing started using it
// again without removing the emptying.
import { expect, test } from "bun:test";
import { db, emptyDeadEventsFts } from "../src/db.ts";

const source = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();

test("the old index is emptied once, and an empty one is left alone", () => {
  db.run("INSERT INTO events_fts(rowid, text) VALUES (72431, 'left over from an older build')");
  expect(emptyDeadEventsFts()).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM events_fts").get()).toEqual({ n: 0 });
  expect(emptyDeadEventsFts()).toBe(false);
});

test("nothing in the database module writes or searches it", () => {
  const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");
  expect(code).not.toContain("INSERT INTO events_fts (");
  expect(code).not.toContain("INSERT INTO events_fts(rowid");
  expect(code).not.toContain("events_fts MATCH");
});
