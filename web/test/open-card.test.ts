// "Show me that card", asked from the pull-request masthead.
//
// The mirror of open-prs' errand, and the rules that bite are the same two: a
// repeat must not look like the request already served, and nobody may assume
// the receiver exists — the Tasks view is mounted the first time somebody goes
// there, which is the very click that sends this.
import { test, expect, afterEach } from "bun:test";
import { onOpenCard, openCard, type CardJump } from "../src/lib/openCard.ts";

afterEach(() => { onOpenCard(null); });

test("asking with nobody listening is not an error", () => {
  // The pull-request panel is mounted long before the Tasks view usually is.
  expect(() => openCard("ORBIT-1042")).not.toThrow();
});

test("the id and what to call it both travel", () => {
  let got: CardJump | null = null;
  onOpenCard((j) => { got = j; });
  openCard("8ab12cd34", "ORBIT-1042");
  // The board looks up the first and shows the second while it does.
  expect(got).toMatchObject({ query: "8ab12cd34", label: "ORBIT-1042" });
});

test("an id with no label speaks for itself", () => {
  let got: CardJump | null = null;
  onOpenCard((j) => { got = j; });
  openCard("ORBIT-1042");
  expect(got!.label).toBe("ORBIT-1042");
});

test("asking twice for the same card is two requests", () => {
  const seen: number[] = [];
  onOpenCard((j) => seen.push(j.n));
  openCard("ORBIT-1042");
  openCard("ORBIT-1042");
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBe(seen[0] + 1);
});

test("unsubscribing stops delivery, and only for the one that unsubscribed", () => {
  let beats = 0;
  const off = onOpenCard(() => { beats++; });
  openCard("ORBIT-1");
  off();
  openCard("ORBIT-2");
  expect(beats).toBe(1);
});
