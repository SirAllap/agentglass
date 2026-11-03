import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { readDeckOpen, writeDeckOpen } from "../src/lib/prFilterView.ts";

// The mockup draws the rules row open: the person's rules are the first thing
// the board is explained by. It rests open and folds only on the person's
// click, which is kept; a storage that throws leaves it open (never hides rules).
const stubGlobal = globalStubs();

describe("the filter deck rests open", () => {
  test("open with nothing stored, kept once folded, open again when storage throws", () => {
    const store = new Map<string, string>();
    stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readDeckOpen()).toBe(true);
    writeDeckOpen(false);
    expect(readDeckOpen()).toBe(false);
    writeDeckOpen(true);
    expect(readDeckOpen()).toBe(true);
    const blocked = () => { throw new Error("blocked"); };
    stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(readDeckOpen()).toBe(true);
    expect(() => writeDeckOpen(true)).not.toThrow();
  });

  test("only the chevron flips it: one setOpen in the deck, seeded from storage", async () => {
    const src = await Bun.file(new URL("../src/components/PrFilterDeck.tsx", import.meta.url)).text();
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.match(/setOpen\(/g)?.length).toBe(1);
    expect(code).toContain("useState(readDeckOpen)");
  });
});
