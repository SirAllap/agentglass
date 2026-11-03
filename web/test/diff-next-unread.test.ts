import { describe, expect, test } from "bun:test";
import type { ChangeRow } from "../../shared/types.ts";
import { nextUnread, unreadCount } from "../src/lib/changeRows.ts";

/* "Next unread": the first file after the one on screen that has no read tick,
   in the order the list shows them, wrapping at the end. Without it the reader
   of a 40-file change pressed j past every file already done. */
const row = (key: string) => ({ key, path: `src/${key}.ts` }) as ChangeRow;
const flat = ["a", "b", "c", "d"].map(row);
const read = (...keys: string[]) => new Set(keys);

describe("nextUnread", () => {
  test("skips files already read", () => {
    expect(nextUnread(flat, "a", read("b", "c"))?.key).toBe("d");
  });
  test("wraps round the end to an unread file above", () => {
    expect(nextUnread(flat, "c", read("d"))?.key).toBe("a");
  });
  test("the file on screen counts last: it is the answer only when nothing else is unread", () => {
    expect(nextUnread(flat, "b", read("a", "c", "d"))?.key).toBe("b");
    expect(nextUnread(flat, "b", read("c"))?.key).toBe("d");
  });
  test("null when everything is read, or the list is empty", () => {
    expect(nextUnread(flat, "a", read("a", "b", "c", "d"))).toBeNull();
    expect(nextUnread([], null, read())).toBeNull();
  });
  test("with nothing selected it starts at the top", () => {
    expect(nextUnread(flat, null, read())?.key).toBe("a");
  });
});

test("unreadCount counts only what is on the list", () => {
  expect(unreadCount(flat, read("a", "zzz-not-listed"))).toBe(3);
});

test("the view binds n to it and the list foot offers it", async () => {
  const src = await Bun.file(new URL("../src/components/diff/DiffPage.tsx", import.meta.url)).text();
  expect(src).toMatch(/e\.key === "n"\) \{ e\.preventDefault\(\); goNextUnread\(\)/);
  expect(src).toContain("Next unread");
  expect(src).toMatch(/unread of \$\{shown\.length\}/);
});
