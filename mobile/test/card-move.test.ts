/*
 * What a move sends, and where the answer goes.
 *
 * The card screen's `move` sent no `updated` stamp — while the comment on the
 * handler next to it said it did — so the server's stale-write guard never
 * ran for it and two people could both win a drag. And it dropped the card the
 * server handed back, so the list behind the screen kept the old column until
 * somebody pulled to refresh.
 *
 * Read from the source, the way handoff-carries-an-id.test.ts reads the
 * hand-off: the claim is about the SHAPE of two calls, and a behavioural test
 * would need a React Native renderer for what a regex says outright.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();

/** The body of the `useCallback` a named handler is assigned. */
function handler(name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, name).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }, [", at);
  return src.slice(at, end);
}

describe("move", () => {
  const move = handler("move");

  test("posts to the status route with the stamp it read, or the one it was handed", () => {
    expect(move).toContain('"/clickup/status"');
    expect(move).toMatch(/body:\s*\{[^}]*\bupdated:\s*how\.stamp \?\? card\.updated\b/);
  });

  test("tells a conflict apart from a refusal, and re-reads the card only for a conflict", () => {
    expect(move).toContain("moveOutcome(answer)");
    expect(move).toMatch(/outcome\.kind === "conflict"[\s\S]*await load\(\)/);
    expect(move.split("await load()").length - 1).toBe(2); // the conflict read, and the no-card fallback
  });

  test("puts the returned card on screen and out to the list", () => {
    expect(move).toContain("landed(outcome.task)");
  });
});

describe("apply (assignees) does the same with what it is handed", () => {
  test("it sends the stamp it read, or the one it was handed, and keeps the answer", () => {
    const apply = handler("apply");
    expect(apply).toMatch(/\bupdated:\s*how\.stamp \?\? card\.updated\b/);
    expect(apply).toContain("moveOutcome(answer)");
    expect(apply).toContain("landed(outcome.task)");
  });
});

describe("landed", () => {
  test("is the one place a returned card is announced", () => {
    const landed = handler("landed");
    expect(landed).toContain("setCard(task)");
    expect(landed).toContain("announceCard(task)");
    // Nothing else on the screen announces on its own — one door, so a
    // future write route cannot forget half of it.
    expect(src.split("announceCard(").length - 1).toBe(1);
  });
});

describe("the button that opens the tracker", () => {
  test("is titled from the catalogue, not typed", () => {
    expect(src).toContain("`Open in ${providerTitle(PROVIDER)}`");
    expect(src).not.toContain('"Open in ClickUp"');
  });
});
