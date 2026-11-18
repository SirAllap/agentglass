// The parsed-frame cache is keyed by tmux session id, ids are never reused, and
// each entry pins a whole raw listing: without a ceiling it grows with uptime.
import { expect, test } from "bun:test";
import { __frameParsedSize, rememberParsedFrame } from "../src/tmuxctl.ts";

const entry = (n: number) => ({ src: { at: n, out: `list ${n}` }, parsed: {}, prefix: [] }) as unknown as Parameters<typeof rememberParsedFrame>[1];

test("retired session ids do not pile up in the parsed-frame cache", () => {
  for (let i = 0; i < 1000; i++) rememberParsedFrame(`-L orbit\0$${i}`, entry(i));
  expect(__frameParsedSize()).toBeLessThanOrEqual(128);
});

test("re-remembering a key does not add a second entry", () => {
  rememberParsedFrame("-L acme\0$1", entry(1));
  const once = __frameParsedSize();
  rememberParsedFrame("-L acme\0$1", entry(2));
  expect(__frameParsedSize()).toBe(once);
});
