import { describe, expect, test } from "bun:test";
import { readDesktopDnd } from "../src/notifications/desktopDnd.ts";

const answer = (value: unknown, ok = true) => (async () => ({ ok, value })) as never;
const host = {} as never;

describe("readDesktopDnd", () => {
  test("on only when the desk is supported and says on", async () => {
    expect(await readDesktopDnd(host, answer({ ok: true, supported: true, on: true }))).toBe(true);
    expect(await readDesktopDnd(host, answer({ ok: true, supported: true, on: false }))).toBe(false);
  });
  test("a desk that cannot say is not DND", async () => {
    expect(await readDesktopDnd(host, answer({ ok: true, supported: false, on: true }))).toBe(false);
    expect(await readDesktopDnd(host, answer({ ok: true, supported: true, on: "yes" }))).toBe(false);
    expect(await readDesktopDnd(host, answer({}, false))).toBe(false);
  });
});
