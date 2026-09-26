/*
 * The issue screen draws the thread the server sends. A rule about source: there
 * is no renderer in this project, and what broke was a screen that carried a
 * count ("Comments 6") and not one of the comments.
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/issue/[number].tsx", import.meta.url)).text();

test("every comment in the thread is drawn, with its author and body", () => {
  expect(src).toContain("detail.thread.map(");
  expect(src).toContain("{c.author}");
  expect(src).toContain("<Md text={c.body.trim()}");
});

test("the bare count is gone: the heading says how many of how many", () => {
  expect(src).not.toContain('<Fact name="Comments"');
  expect(src).toContain("latest ${detail.thread.length} of ${detail.comments}");
});
