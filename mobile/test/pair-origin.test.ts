/*
 * The address somebody types, and the one the app stores.
 *
 * They were different, and that is the whole bug. `submit` normalised the field
 * for its validity check and then the wait that follows read the RAW state, so
 * a phone paired by typing `192.168.1.20:4000` — which is exactly what the
 * placeholder shows — stored an origin with no scheme. Every request after that
 * was schemeless and the first WebSocket died inside java.net.URL with "no
 * protocol:", a red screen carrying a Java stack trace and no mention of an
 * address anywhere.
 *
 * Found by pairing an emulator the way the form tells you to. Held here by
 * reading the source, because the failure is not in what `normalizeOrigin`
 * returns — that was always right — but in whether its answer is the one that
 * survives.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { announce, installed, pairing } from "./npm-deps.ts";

announce("pair-origin.test.ts");

const { normalizeOrigin } = pairing;

const source = readFileSync(join(import.meta.dir, "..", "app", "pair.tsx"), "utf8");

describe.skipIf(!installed)("what the field accepts", () => {
  test("the three ways people write the same computer all normalise", () => {
    expect(normalizeOrigin("192.168.1.20:4000")).toBe("http://192.168.1.20:4000");
    expect(normalizeOrigin("http://192.168.1.20:4000/")).toBe("http://192.168.1.20:4000");
    expect(normalizeOrigin(" 192.168.1.20 ")).toBe("http://192.168.1.20:4000");
    // The one the emulator was paired with, and the one that broke.
    expect(normalizeOrigin("127.0.0.1:4010")).toBe("http://127.0.0.1:4010");
  });

  test("and nonsense is still nonsense", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
  });
});

describe.skipIf(!installed)("and what the app keeps", () => {
  test("every read of the address goes through the normaliser", () => {
    /*
     * The assertion that would have caught it. `const where = origin` is the
     * line that shipped: a bare read of the field, used to build the Host that
     * is written to storage and every URL made from it afterwards.
     */
    expect(source).not.toMatch(/const where = origin\s*;/);
    // Both places that resolve an address do it the same way.
    const uses = [...source.matchAll(/const where = ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const use of uses) expect(use).toContain("normalizeOrigin(origin)");
  });

  test("and the field is rewritten to what will actually be used", () => {
    // So a form that quietly changes what you typed at least shows it.
    expect(source).toContain("if (where !== origin) setOrigin(where)");
  });
});
