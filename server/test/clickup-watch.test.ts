/*
 * Being told when a card of yours moves — and, more importantly, NOT being told
 * things that would teach you to ignore it.
 *
 * Three rules carry this feature, and every one of them is about silence:
 *
 *   - the first look after connecting says nothing, it only records;
 *   - a restart does not re-announce what it announced before;
 *   - a failed read does not move the high-water mark, or the changes it never
 *     saw are lost.
 *
 * ClickUp is swapped through the module's own seam (`__setCardReader`) rather
 * than with `mock.module`: what is being tested is the DIFF, and a suite that
 * needs a workspace is a suite that does not run. The mock was tried first and
 * replaced the module for the WHOLE process, which took the real ClickUp suite
 * down with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTask } from "../../shared/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cuwatch-"));

/** What the workspace answers with, swapped per test. Shaped like the real
 *  reader's `CallResult`, failures included: `unauthorised` used to be typed
 *  away at this seam, which is how a revoked token became a quiet week. */
let answer: { ok: boolean; data?: { tasks: ProviderTask[] }; error?: string; unauthorised?: boolean; throttled?: boolean } =
  { ok: true, data: { tasks: [] } };
let asked: number[] = [];

const W = await import("../src/clickupwatch.ts");

const ME = "9527";
/** A comment as the reader hands it over. */
const said = (o: { id: string; who?: string; whoId?: string; text?: string; at?: number; mentions?: string[] }) =>
  ({ id: o.id, who: o.who ?? "Alejandro", whoId: o.whoId ?? "111", text: o.text ?? "have a look", at: o.at ?? 5_000_000, mentions: o.mentions ?? [] });

const card = (id: string, status: string, customId?: string): ProviderTask =>
  ({ id, customId, title: `card ${id}`, url: "", status, statusKind: "open",
     priority: null, due: null, updated: 0, tags: [], list: null, assignees: [], mine: true } as unknown as ProviderTask);

beforeEach(() => {
  asked = [];
  answer = { ok: true, data: { tasks: [] } };
  W.__setWatchPath(join(dir, `${Math.random().toString(36).slice(2)}.json`));
  W.__setCardReader(async (since) => { asked.push(since); return answer; });
  // No boards and no comments unless a test asks for them, so the assignment
  // half stays readable on its own.
  W.__setBoardReader(async () => ({ ok: true, data: { tasks: [] } }));
  W.__setCommentReader(async () => ({ ok: true, data: { comments: [] } }));
  W.__setMe(ME);
  W.__resetTrouble();
});
afterEach(() => {
  W.__setWatchPath(null); W.__setCardReader(null);
  W.__setBoardReader(null); W.__setCommentReader(null); W.__setMe(null);
  W.__resetTrouble();
});

/** Everything console.warn/log was given while `fn` ran. The "said once" rule
 *  is a claim about a count, so it has to be counted rather than eyeballed. */
async function saidWhile(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn, log = console.log;
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { await fn(); } finally { console.warn = warn; console.log = log; }
  return lines;
}

describe("the first look after connecting", () => {
  it("says nothing, however much has happened", async () => {
    // Otherwise connecting an account announces a day of history at once, which
    // is how somebody learns to ignore the bell on day one.
    answer = { ok: true, data: { tasks: [card("a", "in progress"), card("b", "done")] } };
    expect(await W.pollCards()).toEqual([]);
  });

  it("asks for a day, and only a day", async () => {
    const now = 1_700_000_000_000;
    await W.pollCards(now);
    expect(asked[0]).toBe(now - 24 * 3600_000);
  });

  it("remembers what it saw, so the next look can compare", async () => {
    answer = { ok: true, data: { tasks: [card("a", "in progress")] } };
    await W.pollCards();
    answer = { ok: true, data: { tasks: [card("a", "in review")] } };
    const [n] = await W.pollCards();
    expect(n).toMatchObject({ kind: "status", id: "a", was: "in progress", status: "in review" });
  });
});

describe("what is worth saying", () => {
  const seed = async () => {
    answer = { ok: true, data: { tasks: [card("a", "in progress", "ORBIT-1042")] } };
    await W.pollCards();
  };

  it("a card that was not mine before is an assignment", async () => {
    await seed();
    answer = { ok: true, data: { tasks: [card("z", "to do", "ORBIT-2317")] } };
    expect(await W.pollCards()).toEqual([
      { kind: "assigned", id: "z", label: "ORBIT-2317", title: "card z", status: "to do", url: "" },
    ]);
  });

  it("a card of mine in a new status is a move, and names the one it left", async () => {
    await seed();
    answer = { ok: true, data: { tasks: [card("a", "in review", "ORBIT-1042")] } };
    expect(await W.pollCards()).toEqual([
      { kind: "status", id: "a", label: "ORBIT-1042", title: "card a", status: "in review", was: "in progress", url: "" },
    ]);
  });

  it("a card that came back unchanged is not news", async () => {
    await seed();
    answer = { ok: true, data: { tasks: [card("a", "in progress", "ORBIT-1042")] } };
    expect(await W.pollCards()).toEqual([]);
  });

  it("falls back to the internal id when the workspace has no human ones", async () => {
    await seed();
    answer = { ok: true, data: { tasks: [card("q", "to do")] } };
    expect((await W.pollCards())[0]!.label).toBe("q");
  });
});

describe("when the read fails", () => {
  it("says nothing and does not move the mark", async () => {
    // The changes it did not see are still changes. Moving the high-water mark
    // on a failure is how a notification is lost for good rather than late.
    answer = { ok: true, data: { tasks: [card("a", "in progress")] } };
    await W.pollCards(1_000_000);
    answer = { ok: false };
    expect(await W.pollCards(2_000_000)).toEqual([]);
    answer = { ok: true, data: { tasks: [card("a", "in review")] } };
    await W.pollCards(3_000_000);
    // Asked from the SECOND poll's mark, not the third's — the failure left it
    // where it was.
    expect(asked[2]).toBe(1_000_000 - 60_000);
  });

  /*
   * Nothing was LOST — that part was always right. Nothing was SAID, and that
   * is the whole of T27.
   *
   * `pollCards` returned `[]` for a 401 from a revoked personal token exactly
   * as it did for "no cards moved", and the tick's `catch {}` swallowed
   * anything that got as far as throwing. Two layers of silence over one fact,
   * repeating every three minutes for as long as the server ran: no banner, no
   * log line, no degraded state. Card assignments, status moves and mentions
   * stopped reaching the bell and the feature looked like a quiet week.
   */
  it("latches a refused token, and says which kind of failure it was", async () => {
    answer = { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    expect(await W.pollCards(2_000_000)).toEqual([]);
    expect(W.cardWatchTrouble()).toMatchObject({
      error: "ClickUp refused this token", unauthorised: true, since: 2_000_000, runs: 1,
    });
  });

  it("counts how long it has been failing, so once and all afternoon differ", async () => {
    answer = { ok: false, error: "Could not reach ClickUp" };
    await W.pollCards(1_000_000);
    await W.pollCards(1_180_000);
    await W.pollCards(1_360_000);
    expect(W.cardWatchTrouble()).toMatchObject({ since: 1_000_000, at: 1_360_000, runs: 3 });
  });

  it("says it ONCE, not once every three minutes", async () => {
    // The same treatment alerts.ts gives a missing notify-send: the cause is
    // just as true the next four hundred times, and a line every three minutes
    // is a log nobody skims.
    answer = { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    const said = await saidWhile(async () => {
      for (let i = 1; i <= 5; i++) await W.pollCards(1_000_000 + i * 180_000);
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Reconnect ClickUp");
  });

  it("says it again when the failure becomes a DIFFERENT failure", async () => {
    // A revoked token and an unreachable service have different remedies, so
    // "already said something" is not the same as "already said this".
    const said = await saidWhile(async () => {
      answer = { ok: false, unauthorised: true, error: "ClickUp refused this token" };
      await W.pollCards(1_000_000);
      answer = { ok: false, error: "Could not reach ClickUp" };
      await W.pollCards(1_180_000);
      await W.pollCards(1_360_000);
    });
    expect(said).toHaveLength(2);
  });

  it("does not let a rate hold overwrite a refused token", async () => {
    /*
     * Measured while proving this ticket. With the watcher pointed at a server
     * answering 401, poll 1 latched "ClickUp refused this token" and poll 2
     * replaced it with "Holding off — ClickUp's rate limit is nearly used up",
     * dropping `unauthorised` and downgrading the Settings row from "reconnect"
     * to wait-and-see. A throttled result is a decision made on this side, from
     * a budget the previous failure left behind: it never reached ClickUp, so
     * it carries no news about the token.
     */
    answer = { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    await W.pollCards(1_000_000);
    answer = { ok: false, throttled: true, error: "Holding off — ClickUp's rate limit is nearly used up" };
    await W.pollCards(1_180_000);
    expect(W.cardWatchTrouble()).toMatchObject({ unauthorised: true, error: "ClickUp refused this token", runs: 2 });
  });

  it("clears itself the moment a poll works, and says that once too", async () => {
    answer = { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    await W.pollCards(1_000_000);
    const said = await saidWhile(async () => {
      answer = { ok: true, data: { tasks: [] } };
      await W.pollCards(1_180_000);
      await W.pollCards(1_360_000);
    });
    expect(W.cardWatchTrouble()).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("working again");
  });

  it("stays quiet about a single dropped poll in both directions", async () => {
    // A recovery is only worth a line when the failure got one. Otherwise a
    // blip produces a "working again" for something nobody was told about.
    const said = await saidWhile(async () => {
      answer = { ok: true, data: { tasks: [] } };
      await W.pollCards(1_000_000);
      await W.pollCards(1_180_000);
    });
    expect(said).toEqual([]);
  });
});

describe("across a restart", () => {
  it("does not announce what it has already announced", async () => {
    const file = join(dir, "sticky.json");
    W.__setWatchPath(file);
    answer = { ok: true, data: { tasks: [card("a", "in progress")] } };
    await W.pollCards();
    answer = { ok: true, data: { tasks: [card("a", "in review")] } };
    expect(await W.pollCards()).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
    // A fresh process reads that file rather than starting over.
    W.__setWatchPath(null);
    W.__setWatchPath(file);
    expect(await W.pollCards()).toEqual([]);
  });
});

describe("a poll that has far too much to say", () => {
  it("says the newest few and drops the rest, rather than a wall", async () => {
    // Measured, not imagined: with the window rewound 45 days against a real
    // workspace, one poll produced seventy-one true things at once.
    answer = { ok: true, data: { tasks: [card("seed", "to do")] } };
    await W.pollCards(1_000_000);
    answer = { ok: true, data: { tasks: Array.from({ length: 30 }, (_, i) => card(`n${i}`, "to do", `ORBIT-${i}`)) } };
    const notes = await W.pollCards(2_000_000);
    expect(notes).toHaveLength(8);
    // The last thirty are the newest, so the tail is what survives.
    expect(notes.at(-1)!.label).toBe("ORBIT-29");
  });
});

describe("comments and mentions", () => {
  /** A card of mine, already known, so only the comment is new. */
  const seedMine = async () => {
    answer = { ok: true, data: { tasks: [card("a", "in progress", "ORBIT-1042")] } };
    await W.pollCards(1_000_000);
  };

  it("somebody commenting on a card of mine is news, and it names them", async () => {
    await seedMine();
    W.__setCommentReader(async () => ({ ok: true, data: { comments: [said({ id: "c1", who: "Alejandro", text: "ready for review" })] } }));
    const [n] = await W.pollCards(6_000_000);
    expect(n).toMatchObject({ kind: "comment", id: "a", who: "Alejandro", said: "ready for review" });
  });

  it("a comment that names me is a mention, on anybody's card", async () => {
    await seedMine();
    // Not assigned to me — it only turns up because it moved on a board I follow.
    W.__setBoardReader(async () => ({ ok: true, data: { tasks: [card("z", "to do", "ORBIT-9")] } }));
    W.__setCommentReader(async (id) => ({ ok: true, data: { comments: id === "z" ? [said({ id: "c2", who: "Marta", mentions: [ME] })] : [] } }));
    const notes = await W.pollCards(6_000_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "mention", id: "z", who: "Marta" });
  });

  it("a comment on somebody else's card that does not name me is not my business", async () => {
    await seedMine();
    W.__setBoardReader(async () => ({ ok: true, data: { tasks: [card("z", "to do", "ORBIT-9")] } }));
    W.__setCommentReader(async (id) => ({ ok: true, data: { comments: id === "z" ? [said({ id: "c3" })] : [] } }));
    expect(await W.pollCards(6_000_000)).toEqual([]);
  });

  it("my own comment is not news", async () => {
    await seedMine();
    W.__setCommentReader(async () => ({ ok: true, data: { comments: [said({ id: "c4", whoId: ME, who: "me" })] } }));
    expect(await W.pollCards(6_000_000)).toEqual([]);
  });

  it("the same comment is announced once, however often it comes back", async () => {
    // The window overlaps by a minute on purpose, so a comment does turn up
    // twice. Twice on screen is worse than late.
    await seedMine();
    W.__setCommentReader(async () => ({ ok: true, data: { comments: [said({ id: "c5", at: 6_500_000 })] } }));
    expect(await W.pollCards(7_000_000)).toHaveLength(1);
    expect(await W.pollCards(8_000_000)).toEqual([]);
  });

  it("a comment older than the window is not dragged up", async () => {
    await seedMine();
    W.__setCommentReader(async () => ({ ok: true, data: { comments: [said({ id: "c6", at: 100 })] } }));
    expect(await W.pollCards(6_000_000)).toEqual([]);
  });
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* going away anyway */ } });
