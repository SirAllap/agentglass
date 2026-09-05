/*
 * Where each field goes on the card.
 *
 * Written against the three faults on screen in a real workspace: a bug form writing
 * "Steps to reproduce" into a custom field AND into the description word for word, so
 * the card drew both; a header grid of thirteen unrelated values with a paragraph in
 * one column; and the two or three fields a squad actually triages by buried among
 * them.
 */
import { describe, expect, it } from "bun:test";
import type { CardField } from "../../shared/providers.ts";
import { BAND_LABEL_MAX, BAND_MAX, MIN_ECHO, bandWorthy, echoes, labelOf, layoutCard, normalise, repeatsPriority } from "../src/lib/cardLayout.ts";

const f = (over: Partial<CardField> & { name: string }): CardField =>
  ({ id: over.name, value: "v", kind: "chip", ...over } as CardField);

const LONG = "The agent is marked busy the moment the outbound request is accepted, before the call is placed at all.";

describe("what the description already says", () => {
  it("folds away a field the body repeats", () => {
    const field = f({ name: "Actual behaviour", kind: "text", value: LONG });
    expect(echoes(`## Actual behaviour\n\n${LONG}\n`, field)).toBe(true);
  });

  it("through different punctuation, bullets and line breaks", () => {
    const steps = "1. Accept the outbound request\n2. Watch the agent's state before the call connects";
    const field = f({ name: "Steps", kind: "text", value: steps });
    expect(echoes("Steps to reproduce:\n\n1) Accept the outbound request — 2) Watch the agent's state before the call connects", field)).toBe(true);
  });

  it("keeps a field the body does NOT say", () => {
    expect(echoes("Something else entirely, at length, about another matter.", f({ name: "A", kind: "text", value: LONG }))).toBe(false);
  });

  // "No" occurs in almost any paragraph. Folding a field away because its one-word
  // value happens to appear in the prose would hide a real answer.
  it("never folds a short value away, however common its words are", () => {
    const short = f({ name: "Surfaced by pro", kind: "text", value: "No" });
    expect(echoes("No, this was not surfaced by a pro at all.", short)).toBe(false);
    expect(MIN_ECHO).toBeGreaterThan(10);
  });

  it("and only ever folds text — a chip is not prose", () => {
    expect(echoes(LONG, f({ name: "X", kind: "chip", value: LONG }))).toBe(false);
  });

  it("normalises to letters and digits, so formatting cannot fool it", () => {
    expect(normalise("**Steps** to  reproduce:\n1.")).toBe("steps to reproduce 1");
  });
});

describe("the band", () => {
  it("takes a coloured choice — the workspace painted it for a reason", () => {
    expect(bandWorthy(f({ name: "Squad", color: "#c034eb" }))).toBe(true);
    expect(bandWorthy(f({ name: "Task type" }))).toBe(false);
  });

  it("takes dates and quantities, and never text or a link", () => {
    expect(bandWorthy(f({ name: "Triage", kind: "date", at: 1 }))).toBe(true);
    expect(bandWorthy(f({ name: "SWAG", kind: "number" }))).toBe(true);
    expect(bandWorthy(f({ name: "Steps", kind: "text", value: LONG }))).toBe(false);
    expect(bandWorthy(f({ name: "Call", kind: "url", href: "https://x" }))).toBe(false);
  });

  // Reported from the app, with a screenshot: this field name wrapped its label onto a
  // second line and stretched a one-word value into a chip the width of the pane.
  it("refuses a name too long to be read at a glance", () => {
    expect(bandWorthy(f({ name: "Is this issue concerning a specific call/chat?", color: "#c034eb" }))).toBe(false);
    expect(BAND_LABEL_MAX).toBeLessThan(30);
  });

  it("judges that length on what the card draws, not on the maintenance note", () => {
    expect(labelOf("Support Tool URL (MPL)")).toBe("Support Tool URL");
    expect(bandWorthy(f({ name: "Support Tool URL (MPL)", kind: "number" }))).toBe(true);
  });

  it("stops at six, because a band that wraps is the grid it replaced", () => {
    const many = Array.from({ length: 10 }, (_, i) => f({ name: `C${i}`, color: "#fff" }));
    expect(layoutCard(many, "").band).toHaveLength(BAND_MAX);
  });
});

describe("the whole layout", () => {
  const fields: CardField[] = [
    f({ name: "Squad", color: "#c034eb", value: "Orbit" }),
    f({ name: "Urgency", color: "#e0a020", value: "High" }),
    f({ name: "Triage date", kind: "date", at: 1783414800000, value: "2026-07-07T00:00:00.000Z" }),
    f({ name: "Call link", kind: "url", href: "https://calls.example/x", value: "calls.example/x" }),
    f({ name: "Reported by", kind: "people", value: "Ada Quill" }),
    f({ name: "Actual behaviour", kind: "text", value: LONG }),
    f({ name: "Impact", kind: "text", value: "Support has to check every one of them by hand, which is where the hours go." }),
  ];
  const body = `## Actual behaviour\n\n${LONG}\n`;
  const out = layoutCard(fields, body);

  it("puts the coloured, dated and counted things in the band", () => {
    expect(out.band.map((x) => x.name)).toEqual(["Squad", "Urgency", "Triage date"]);
  });

  it("draws a long field the body does not have, and counts the one it does", () => {
    expect(out.long.map((x) => x.name)).toEqual(["Impact"]);
    expect(out.echoed.map((x) => x.name)).toEqual(["Actual behaviour"]);
  });

  // The band is a summary; the Fields section is the record. A field missing from the
  // record because it made the summary would mean the list is only complete when the
  // band is empty.
  it("keeps every non-text field in the rows, band or no band", () => {
    expect(out.rows.map((x) => x.name)).toEqual(["Squad", "Urgency", "Triage date", "Call link", "Reported by"]);
  });

  it("and a card with nothing on it lays out to nothing at all", () => {
    expect(layoutCard([], "")).toEqual({ band: [], long: [], echoed: [], rows: [] });
  });

  it("drops a field whose value is empty rather than drawing a blank row", () => {
    expect(layoutCard([f({ name: "Empty", value: "" })], "").rows).toEqual([]);
  });
});

/*
 * ClickUp has a priority of its own — the flag — and a list can carry a drop-down
 * that means the same thing and is called Urgency. One card showed `Normal` twice
 * on one screen because of it.
 */
describe("a list's own copy of the priority flag", () => {
  const urgency = f({ id: "u", name: "Urgency", value: "Normal", color: "#4194f6" });

  it("does not ride the band when it says exactly what the flag says", () => {
    expect(repeatsPriority(urgency, "normal")).toBe(true);
    expect(layoutCard([urgency], "", "normal").band).toEqual([]);
  });

  it("stays in the rows, because it is still a field of that list", () => {
    expect(layoutCard([urgency], "", "normal").rows.map((x) => x.name)).toEqual(["Urgency"]);
  });

  it("is kept when it disagrees with the flag — that is news, not noise", () => {
    expect(repeatsPriority(urgency, "high")).toBe(false);
    expect(layoutCard([urgency], "", "high").band.map((x) => x.name)).toEqual(["Urgency"]);
  });

  it("is kept on a card with no flag at all, where nothing repeats anything", () => {
    expect(repeatsPriority(urgency, null)).toBe(false);
    expect(layoutCard([urgency], "").band.map((x) => x.name)).toEqual(["Urgency"]);
  });

  it("only for a field named after the flag — a Squad that reads Normal is its own field", () => {
    const squad = f({ id: "s", name: "Squad", value: "Normal", color: "#a55" });
    expect(repeatsPriority(squad, "normal")).toBe(false);
  });
});
