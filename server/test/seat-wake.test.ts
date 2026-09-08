/*
 * WAKING THE SEAT ON A CHANGE — and, more to the point, NOT waking it without
 * one.
 *
 * The hand-run version of this post woke every twenty minutes and, over one
 * afternoon, said "no change" in twelve of fourteen rounds. Those twelve are
 * what these tests exist to keep at zero: silence when the field is the same
 * is the feature, and it is the kind of feature that quietly stops working
 * when somebody puts the elapsed time into the comparison.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/lanternwatch.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-seatwake-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const { fingerprint, wakeLine, wakeSeats, __resetSeatWake } = await import("../src/seatwake.ts");

const waiting = (name: string, since = 1_000): Finding => ({ kind: "waiting", name, since, line: `${name} needs your permission — 7m: Bash` });
const gone = (name: string, since = 1_000): Finding => ({ kind: "gone", name, since, line: `${name}'s window is gone` });

const ROOT = "/home/a/code/orbit";
const seats = () => [{ root: ROOT, endedAt: null as number | null }];

describe("what counts as a change", () => {
  test("the same findings, later, are not a change", () => {
    /* The wording carries "7m", which becomes "8m" a minute later. If that
       reached the comparison, every look would be a change and the clock
       would be back. */
    const a = [waiting("db-fix", 1_000)];
    const b = [{ ...waiting("db-fix", 1_000), line: "db-fix needs your permission — 23m: Bash" }];
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test("order does not make a change", () => {
    expect(fingerprint([waiting("a"), gone("b")])).toBe(fingerprint([gone("b"), waiting("a")]));
  });

  test("a new agent, or a new kind for the same agent, is a change", () => {
    expect(fingerprint([waiting("a")])).not.toBe(fingerprint([waiting("a"), waiting("b")]));
    expect(fingerprint([waiting("a")])).not.toBe(fingerprint([gone("a")]));
  });
});

describe("who gets woken", () => {
  beforeEach(() => __resetSeatWake());

  test("nobody, when nothing changed and the floor has not passed", async () => {
    const sent: string[] = [];
    const prompt = async (_n: string, t: string) => { sent.push(t); };
    const f = [waiting("db-fix")];
    /* First look: the seat has just read the whole field in its opening
       prompt, so it is recorded and not woken. */
    expect(await wakeSeats(f, { seats, prompt, now: 0 })).toEqual([]);
    expect(await wakeSeats(f, { seats, prompt, now: 60_000 })).toEqual([]);
    expect(await wakeSeats(f, { seats, prompt, now: 120_000 })).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("the seat, the moment a finding appears — with what is new in the line", async () => {
    const sent: string[] = [];
    const prompt = async (_n: string, t: string) => { sent.push(t); };
    await wakeSeats([], { seats, prompt, now: 0 });
    const woken = await wakeSeats([waiting("db-fix")], { seats, prompt, now: 60_000 });
    expect(woken).toEqual([ROOT]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("db-fix needs your permission");
  });

  test("and when a finding clears, which is also news", async () => {
    const sent: string[] = [];
    const prompt = async (_n: string, t: string) => { sent.push(t); };
    await wakeSeats([waiting("db-fix")], { seats, prompt, now: 0 });
    await wakeSeats([], { seats, prompt, now: 60_000 });
    expect(sent[0]).toContain("The field is clear");
  });

  test("a quiet day still gets a line once the floor passes", async () => {
    const sent: string[] = [];
    const prompt = async (_n: string, t: string) => { sent.push(t); };
    const f = [waiting("db-fix")];
    await wakeSeats(f, { seats, prompt, now: 0 });
    expect(await wakeSeats(f, { seats, prompt, now: 3 * 3_600_000 })).toEqual([]);
    expect(await wakeSeats(f, { seats, prompt, now: 5 * 3_600_000 })).toEqual([ROOT]);
    expect(sent[0]).toContain("Nothing has changed");
  });

  test("an empty chair is not woken", async () => {
    const sent: string[] = [];
    const prompt = async (_n: string, t: string) => { sent.push(t); };
    const closed = () => [{ root: ROOT, endedAt: 5 }];
    await wakeSeats([], { seats: closed, prompt, now: 0 });
    await wakeSeats([waiting("db-fix")], { seats: closed, prompt, now: 60_000 });
    expect(sent).toEqual([]);
  });
});

describe("the line the seat is woken with", () => {
  test("names only what is new, not the whole field again", () => {
    const before = fingerprint([waiting("old-one")]);
    const line = wakeLine([waiting("old-one"), gone("new-one")], before);
    expect(line).toContain("new-one");
    expect(line).not.toContain("old-one");
  });

  test("says the field is clear when it is, rather than saying nothing", () => {
    expect(wakeLine([], fingerprint([waiting("a")]))).toContain("clear");
  });
});
