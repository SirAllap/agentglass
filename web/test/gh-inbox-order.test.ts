/*
 * "Sort: <plugin>" on the Inbox.
 *
 * A plugin gives some rows a number; the person may order the list by it. The
 * rule that matters is not the order but what it cannot do: every row it was
 * given comes back, and the default stays newest first until somebody picks
 * the plugin.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { InboxItem } from "../../shared/types.ts";
import { annotationKey, orderByAnnotation, sorters } from "../src/lib/ghInbox.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T10:00:00Z");
const note = (id: string, ageDays: number, a?: { score?: number; rank?: number; plugin?: string }): InboxItem => ({
  id, unread: true, reason: "subscribed", type: "PullRequest", repo: "acme/orbit", title: `Thread ${id}`, at: T0 - ageDays * DAY,
  ...(a ? { annotations: [{ plugin: a.plugin ?? "orbit-scorer", ...(a.score !== undefined ? { score: a.score } : null), ...(a.rank !== undefined ? { rank: a.rank } : null) }] } : null),
});

describe("orderByAnnotation", () => {
  test("highest number first; ties and rows with no number newest first, numbered rows ahead", () => {
    const rows = [note("old-none", 5), note("low", 1, { score: 0.1 }), note("new-none", 0), note("high", 3, { score: 0.9 }), note("tie-old", 4, { score: 0.5 }), note("tie-new", 2, { score: 0.5 })];
    expect(orderByAnnotation(rows, "orbit-scorer").map((n) => n.id)).toEqual(["high", "tie-new", "tie-old", "low", "new-none", "old-none"]);
  });

  test("a rank wins over a score on the same row", () => {
    const rows = [note("a", 0, { score: 0.99, rank: 1 }), note("b", 0, { score: 0.1, rank: 5 })];
    expect(orderByAnnotation(rows, "orbit-scorer").map((n) => n.id)).toEqual(["b", "a"]);
  });

  test("it never drops or duplicates a row, and never mutates its input", () => {
    const rows = [note("1", 0, { score: 0 }), note("2", 1), note("3", 2, { score: 1 }), note("4", 3, { plugin: "someone-else", score: 1 })];
    const before = rows.map((n) => n.id);
    const out = orderByAnnotation(rows, "orbit-scorer");
    expect(out).toHaveLength(rows.length);
    expect([...out.map((n) => n.id)].sort()).toEqual([...before].sort());
    expect(rows.map((n) => n.id)).toEqual(before);
  });

  test("only the chosen plugin's numbers count", () => {
    const rows = [note("mine", 9, { score: 0.9 }), note("theirs", 0, { plugin: "someone-else", score: 1 })];
    expect(orderByAnnotation(rows, "orbit-scorer").map((n) => n.id)).toEqual(["mine", "theirs"]);
    expect(annotationKey(rows[1]!, "orbit-scorer")).toBeUndefined();
  });
});

describe("sorters", () => {
  test("names the plugins that gave a row a number, once each; a badge alone is not a sort", () => {
    const badgeOnly: InboxItem = { ...note("b", 0), annotations: [{ plugin: "badger", badge: { text: "hi" } }] };
    expect(sorters([note("1", 0, { score: 0.2 }), badgeOnly, note("2", 1, { plugin: "acme-sorter", rank: 3 }), note("3", 2, { score: 0.4 })])).toEqual(["orbit-scorer", "acme-sorter"]);
    expect(sorters([note("1", 0)])).toEqual([]);
  });
});

describe("the Inbox screen", () => {
  const src = readFileSync(new URL("../src/components/prs/Inbox.tsx", import.meta.url), "utf8");
  test("time stays the default: the plugin's order is only ever the person's pick", () => {
    expect(src).toContain("useState<string | null>(null)");
    expect(src).toContain("orderByAnnotation(list, sortBy)");
  });
});
