import { expect, test } from "bun:test";
import { afterNote, entered, finished } from "../src/loopwatch.ts";

test("afterNote names the last label to finish and how long before the stall it ended", () => {
  expect(afterNote(null, 1000)).toBe("");
  expect(afterNote({ what: "boot:x", at: 900, done: 0 }, 1000)).toBe(""); // still running: not "finished"
  expect(afterNote({ what: "boot:x", at: 900, done: 988 }, 1000)).toBe("after boot:x, ended 12ms before the stall");
  expect(afterNote({ what: "boot:x", at: 900, done: 1040 }, 1000)).toBe("after boot:x, ended 40ms into the stall");
});

test("finished() is what records it", () => {
  const m = entered("GET /thing");
  finished(m);
  expect(afterNote(m, m.done + 5)).toBe("after GET /thing, ended 5ms before the stall");
});
