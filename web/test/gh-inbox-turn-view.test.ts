/*
 * The "Your turn" view: what it lists, what it only counts, and what it says.
 *
 * The decision about WHO wrote something is the server's (server/test/
 * gh-inbox-turn.test.ts); this pins what the view does with the answer. The
 * rule that cost a design round: news that only a bot wrote is never a row of
 * this view, and never silently gone either — it is counted, so the list can
 * say how many it left out.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import type { InboxItem, InboxTurnKind } from "../../shared/types.ts";
import { botOnly, filterInbox, TURN_CHIP, turnLine, yourTurn } from "../src/lib/ghInbox.ts";
import { __resetMarks, onShelf, setDone } from "../src/lib/inboxMarks.ts";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);

const row = (id: string, reason: string, turn?: InboxItem["turn"], over: Partial<InboxItem> = {}): InboxItem => ({
  id, unread: true, reason, type: "PullRequest", repo: "acme/orbit", title: `ORBIT-${id} A title`,
  at: Date.parse("2026-08-19T10:00:00Z"), number: Number(id), ...(turn ? { turn } : null), ...over,
});

const items = [
  row("1042", "review_requested", { kind: "review", by: "riley-dev" }),
  row("1038", "author", { kind: "changes", by: "sam-orbit", snippet: "The timeout path has no test yet." }),
  row("1035", "author", { kind: "person", by: "jo-acme", snippet: "Looks right to me." }),
  row("1029", "mention", { kind: "mention", by: "riley-dev", snippet: "@me-dev does this match staging?" }, { type: "Issue" }),
  row("1021", "author", { kind: "bot", by: "ci-app[bot]", snippet: "Coverage 91.4 %." }),
  row("1050", "comment"),
  row("1051", "subscribed"),
];

describe("what is a row of Your turn", () => {
  test("everything the server said waits on the person, and never a bot's news", () => {
    expect(items.filter(yourTurn).map((n) => n.id)).toEqual(["1042", "1038", "1035", "1029"]);
  });

  test("bot-only is the complement that has a turn: counted, not listed", () => {
    expect(items.filter(botOnly).map((n) => n.id)).toEqual(["1021"]);
  });

  test("a thread you merely follow has no turn and is neither", () => {
    for (const id of ["1050", "1051"]) {
      const n = items.find((x) => x.id === id)!;
      expect(yourTurn(n)).toBe(false);
      expect(botOnly(n)).toBe(false);
    }
  });
});

describe("the shelf", () => {
  beforeEach(() => { localStorage.clear(); __resetMarks(); });

  // "Your turn" is the inbox shelf seen through `yourTurn`; nothing is stored under it.
  const turn = (list: InboxItem[]) => onShelf(list, "inbox").filter(yourTurn);

  test("Your turn is a part of the inbox, not a second copy: finishing a thread takes it off both", () => {
    expect(turn(items).map((n) => n.id)).toEqual(["1042", "1038", "1035", "1029"]);
    setDone("1038", true);
    expect(turn(items).map((n) => n.id)).not.toContain("1038");
    expect(onShelf(items, "inbox").map((n) => n.id)).not.toContain("1038");
  });

  test("the inbox itself still holds the bot-only row and the threads you follow", () => {
    expect(onShelf(items, "inbox").length).toBe(items.length);
  });

  test("the unread toggle composes with it", () => {
    const read = items.map((n) => (n.id === "1035" ? { ...n, unread: false } : n));
    expect(filterInbox(turn(read), { unread: true }).map((n) => n.id)).toEqual(["1042", "1038", "1029"]);
  });
});

describe("what a row says", () => {
  test("every kind has a chip, and only the two that ask something of you are tinted", () => {
    const kinds: InboxTurnKind[] = ["review", "changes", "person", "mention", "bot"];
    expect(Object.keys(TURN_CHIP).sort()).toEqual([...kinds].sort());
    expect(TURN_CHIP.review.tone).toBe("accent");
    expect(TURN_CHIP.changes.tone).toBe("warn");
    expect(TURN_CHIP.bot.label).toBe("bot only");
  });

  test("a request says what was asked; a comment quotes what was said", () => {
    expect(turnLine({ kind: "review", by: "riley-dev" })).toEqual({ by: "riley-dev", text: "asked for your review" });
    expect(turnLine({ kind: "person", by: "jo-acme", snippet: "Looks right to me." })).toEqual({ by: "jo-acme", text: "“Looks right to me.”" });
  });

  test("with nothing to say the line is empty rather than a dangling verb", () => {
    expect(turnLine({ kind: "review" })).toEqual({ by: "", text: "" });
    expect(turnLine({ kind: "mention", by: "riley-dev" })).toEqual({ by: "riley-dev", text: "" });
  });
});
