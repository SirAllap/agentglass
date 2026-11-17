import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* A caller of browserOffReason that leaves out the project's flow roles reads
   every saved flow role as unknown and refuses it, even when its row in
   Settings ▸ Browser is on: re-issuing a credential for such a tab did exactly
   that once. Every call in the server passes the fifth argument. */
const SRC = join(import.meta.dir, "..", "src");
const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
const calls = files.flatMap((f) => {
  const text = readFileSync(join(SRC, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  return [...text.matchAll(/browserOffReason\(([^;]*?)\);/gs)].map((m) => ({ f, args: m[1] }));
});

describe("browserOffReason callers", () => {
  test("there are callers to check", () => {
    expect(calls.length).toBeGreaterThan(1);
  });
  test("every caller passes the project's flow roles", () => {
    expect(calls.filter((c) => !/flowRolesOf\(/.test(c.args)).map((c) => c.f)).toEqual([]);
  });
});
