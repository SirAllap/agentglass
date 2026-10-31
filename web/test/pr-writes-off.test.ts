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
    // Merge-with-card (a status write, or the card write when it also assigns),
    // review menu, status, people, hand-off, note, and the staged card move (which
    // reads writeBlock first and writes only after the person's yes). The review
    // picker's own card write lives in PrAskPicker.tsx, pinned below.
    expect(calls.length).toBe(7);
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
    for (const name of ["CardStatusPick", "CardPeoplePick", "CardReadyForQaButton", "CardFacts"]) {
      const body = enclosing(src.indexOf(`function ${name}(`) + 1).body;
      expect(body.includes("disabled={"), `${name} has no disabled control`).toBe(true);
      expect(/blocked \?\? /.test(body) || /\{blocked\}/.test(body), `${name} never says why`).toBe(true);
    }
  });
});

const ask = await Bun.file(new URL("../src/components/PrAskPicker.tsx", import.meta.url)).text();

describe("the review picker's card half, in PrAskPicker", () => {
  it("reads writeBlock and plans no card step while writes are off", () => {
    expect(ask).toContain("const blocked = cardWriteBlock(kind, setup, jiraSettings);");
    expect(ask).toContain("...(readOnly ? { readOnly: true } : null)");
    expect(ask).toContain("const statusPick = readOnly ? \"\" :");
  });
  it("disables the controls in place and says why", () => {
    expect(ask).toContain("disabled={readOnly || locked}");
    expect(ask).toContain("{side.blocked}");
    expect(ask).toContain("is read-only for this token.");
  });
});

describe("the read-only note is the mockup's blue, not a warning", () => {
  it("draws the note and its lock in the info tone", async () => {
    const ask = await Bun.file(new URL("../src/components/PrAskPicker.tsx", import.meta.url)).text();
    const a = ask.indexOf("{readOnly && (");
    const note = ask.slice(a, ask.indexOf("</div>)}", a));
    expect(note).toContain("var(--info)");
    expect(note).not.toContain("var(--warning)");
  });
});
