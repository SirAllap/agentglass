import { describe, expect, it } from "bun:test";
import { writeBlock, WRITES_OFF } from "../src/lib/cardWrites.ts";

/*
 * Writes to ClickUp are off until somebody turns them on, and the server
 * refuses every one while they are. The pull request sidebar drew its controls
 * as live and let the refusal be the first anybody heard of it; they are now
 * disabled in place with the reason.
 */
const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("writeBlock", () => {
  it("blocks only when the setup says writes are off", () => {
    expect(writeBlock({ writeEnabled: false })).toBe(WRITES_OFF);
  });
  it("lets writes through when they are on", () => {
    expect(writeBlock({ writeEnabled: true })).toBeNull();
  });
  it("does not block on unknown: the setup not read yet, or a read that failed", () => {
    expect(writeBlock(null)).toBeNull();
    expect(writeBlock(undefined)).toBeNull();
    expect(writeBlock({})).toBeNull();
  });
  it("says that writes are off and where to switch them on", () => {
    expect(WRITES_OFF).toBe("Changes to ClickUp are off. Turn them on in Tasks.");
  });
});

/** The top-level function around an offset: from the last `function` at column
 *  zero before it to the next one after. */
function enclosing(at: number): { name: string; body: string } {
  const re = /^(?:export )?(?:async )?function (\w+)\(/gm;
  let start = -1, name = "";
  for (let m = re.exec(src); m && m.index < at; m = re.exec(src)) { start = m.index; name = m[1]!; }
  expect(start, "no enclosing function").toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", at);
  const next2 = src.indexOf("\nexport function ", at);
  const ends = [next, next2].filter((n) => n > -1);
  return { name, body: src.slice(start, ends.length ? Math.min(...ends) : undefined) };
}

describe("every ClickUp write in PrPanel", () => {
  const calls = [...src.matchAll(/api\.clickup(?:Card|Status|Comment)\(/g)].map((m) => m.index!);

  it("finds the call sites it is supposed to guard", () => {
    // Merge-with-card, review menu, status, people, hand-off, note.
    expect(calls.length).toBe(6);
  });

  it("sits in a component that reads writeBlock, bar the merge", () => {
    for (const at of calls) {
      const { name, body } = enclosing(at);
      // The merge form's card move is the merge dialog's own switch: it only
      // carries a card when that toggle was on.
      if (name === "PrView") continue;
      expect(body.includes("writeBlock("), `${name} writes to ClickUp without reading writeBlock`).toBe(true);
    }
  });

  it("disables the control rather than hiding it", () => {
    for (const name of ["CardStatusPick", "CardPeoplePick", "CardReadyForQaButton", "CardFacts", "ClickUpSide"]) {
      const body = enclosing(src.indexOf(`function ${name}(`) + 1).body;
      expect(body.includes("disabled={"), `${name} has no disabled control`).toBe(true);
      expect(/blocked \?\? /.test(body) || /\{blocked\}/.test(body), `${name} never says why`).toBe(true);
    }
  });
});
