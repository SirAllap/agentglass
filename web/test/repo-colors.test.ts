import { expect, test } from "bun:test";
import { repoColor } from "../src/lib/format.ts";

test("repo breakdown entries use distinct categorical colors", () => {
  const colors = Array.from({ length: 12 }, (_, i) => repoColor(i));
  expect(new Set(colors).size).toBe(colors.length);
  expect(repoColor(0)).not.toBe(repoColor(2));
});
