/*
 * The weighted figure, where the panes actually read it — #298.
 *
 * `equivalentTokens` being right is one thing; every producer in db.ts calling
 * it is the thing that was missing, and a unit test of the helper passes just
 * as happily when no query calls it.
 *
 * Two kinds of assertion here, and both are needed:
 *
 *  - *agreement*. The headline, the legend beneath it, the per-app table and
 *    the timeline are four numbers a reader checks against each other, built by
 *    four separate folds over one set of events. Four folds is how a dashboard
 *    comes to contradict itself.
 *  - *exact value*. Agreement alone is satisfied by four folds that are wrong
 *    the same way — which is exactly what happens when a folded row is weighted
 *    by its display label instead of by the raw ids that fed it. So every fold
 *    is compared against a number the fixture computed from those ids.
 *
 * Driven through a child process (test/fixtures/eqtok-probe.ts). `db.ts` is a
 * singleton and `bun test` shares one process, so which database it talks to —
 * and which workspace scope it filters by — is decided by whichever suite
 * imported it first. An in-process version of this file found zero of its own
 * rows in a full run while passing on its own.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equivalentTokens, priceFor, modelLabel } from "../src/pricing.ts";

type Row = Record<string, any>;
let out: Row;
let TURN: Row, RAW: number;

const MODELS = ["claude-opus-4.5", "claude-haiku-4.5", "gpt-5.6"];
/** input + output for one turn — what every pane used to show. */
const IN_OUT = 1_500;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-eqstats-"));
  const p = Bun.spawnSync(["bun", "run", new URL("./fixtures/eqtok-probe.ts", import.meta.url).pathname, dir], {
    // Named, never `...process.env`: this suite's own AGENTGLASS_DB and
    // workspace scope are precisely what the child must not inherit.
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const text = p.stdout.toString().trim();
  if (p.exitCode !== 0 || !text) {
    throw new Error(`the probe failed (${p.exitCode}): ${p.stderr.toString().slice(0, 600)}`);
  }
  out = JSON.parse(text.split("\n").at(-1)!);
  TURN = out.turn;
  RAW = TURN.input_tokens + TURN.output_tokens + TURN.cache_creation_tokens + TURN.cache_read_tokens;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("what a weighted row says that the old sum did not", () => {
  test("a cache-heavy turn is a fraction of its raw token count", () => {
    // 203,500 tokens on Opus is 26,000 input-equivalents: each of the 200k
    // cache reads is a tenth of an input token. A session that re-reads a large
    // context every turn — most of them — looked enormous and is cheap.
    for (const m of MODELS) {
      const eq = equivalentTokens(TURN, m);
      expect(eq, m).toBeLessThan(RAW / 3);
      // …and above input+output, which is what every pane used to show:
      // dropping the cache classes is not conservative, it is simply wrong.
      expect(eq, m).toBeGreaterThan(IN_OUT);
    }
  });
});

describe("every fold gets the same, right number", () => {
  test("the headline", () => {
    expect(out.totals.equiv_tokens).toBe(out.expected_total);
    expect(out.totals.equiv_tokens).toBeGreaterThan(0);
  });

  test("the per-model legend, weighted by the raw ids rather than by the label", () => {
    /*
     * `gpt-5.6` is in the fixture for this test alone. Its display label is
     * "GPT-5" and the GPT-5 price row is NOT its rate — cache writes are free
     * there and cost 1.25x input on 5.6 — so a fold that weighted itself by the
     * name it shows lands 1,500 equivalents short and still adds up perfectly
     * against every other fold. Only an exact expectation catches that.
     */
    const got = Object.fromEntries(out.by_model.map((m: Row) => [m.model_name, m.equiv_tokens]));
    expect(got).toEqual(out.expected_by_label);
    // Belt and braces on the fixture itself: if a table change made those two
    // price the same, this test would go on passing while proving nothing.
    expect(equivalentTokens(TURN, "gpt-5.6"), "the fixture model no longer distinguishes label from rate")
      .not.toBe(equivalentTokens(TURN, modelLabel("gpt-5.6")));
  });

  test("the per-app table, which had to be regrouped to be weightable at all", () => {
    // `by_app` was a GROUP BY on the app alone, which has no model in it. It
    // groups by both and folds now — this catches a fold that drops or
    // double-counts a group.
    const got = Object.fromEntries(out.by_app.map((a: Row) => [a.source_app, a.tokens]));
    expect(got).toEqual(out.expected_by_app);
  });

  test("and the timeline buckets", () => {
    expect(out.timeline_tokens).toBe(out.expected_total);
  });
});

describe("the per-app session count", () => {
  test("survived the regroup", () => {
    /*
     * `sessions` is a COUNT(DISTINCT), which does not survive a fold. One app
     * in the fixture ran two models inside a *single* session, so a count
     * accumulated across the model rows reads 2 — and a table that doubles its
     * session count for anybody who switched model mid-run is wrong in a way
     * that looks entirely plausible.
     */
    expect(out.by_app).toHaveLength(2);
    for (const a of out.by_app as Row[]) expect(Number(a.sessions), a.source_app).toBe(1);
  });
});

describe("the shapes the panes read one at a time", () => {
  test("a session carries its own weighted figure", () => {
    // Every SessionRollup in the app comes through one parse, so this covers
    // the list, the socket frame and the fleet's roll-up lookup at once.
    expect(out.sessions).toHaveLength(2);
    for (const s of out.sessions as Row[]) {
      expect(s.equiv_tokens, s.session_id).toBe(s.expected);
      expect(s.equiv_tokens, s.session_id).toBeGreaterThan(s.input_tokens + s.output_tokens);
    }
  });

  test("and so does a single event, which is what the fleet folds", () => {
    // The client has no price table and never will — this is the same trick
    // `cost_usd` already uses, and it is what lets a fleet card show a number
    // that means anything at all.
    expect(out.events).toHaveLength(MODELS.length);
    for (const e of out.events as Row[]) {
      expect(e.equiv_tokens, String(e.id)).toBe(e.expected);
      expect(e.equiv_tokens, String(e.id)).toBeGreaterThan(0);
    }
  });

  test("and a session's detail pane, which never even had the cache columns", () => {
    /*
     * `SessionDetail` selected input and output and nothing else, which is why
     * its "Tokens" stat was those two: not a decision, just what the query
     * happened to return. Asserted as an exact number — "greater than
     * input+output" stays true of the un-fixed query, since output alone
     * outweighs input.
     */
    expect(out.detail).toBeTruthy();
    expect(out.detail.equiv_tokens).toBe(out.detail.expected);
    expect(out.detail.equiv_tokens).toBeGreaterThan(out.detail.input_tokens + out.detail.output_tokens);
  });
});

describe("the price table backs all of it", () => {
  test("every model used here is priced, so none of the above is a fallback", () => {
    // If a rename made these unknown, every figure would quietly fall to
    // DEFAULT_PRICE and the folds would still agree — against the wrong rate.
    for (const m of MODELS) expect(priceFor(m), m).not.toBeNull();
  });
});
