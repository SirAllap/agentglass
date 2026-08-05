// The plan meters keep their numbers through a burst of 429s, which means the
// strip has to be honest about how old they are. Both halves matter: labelling
// a healthy reading trains you to ignore the label, and not labelling a stuck
// one is the other way to lie about it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stalenessLabel, STALE_AFTER_MS } from "../src/lib/usageAge.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// The top bar, not the notch. These assertions were pointed at DynamicIsland,
// which the shell rethink orphaned — so they went on passing about a file
// nothing mounted while the surface that replaced it quietly lost both the
// staleness marking and the per-model windows. A test aimed at dead code is
// worse than no test: it reports that a property holds when nothing is checking
// the thing that has it.
const bar = read("src/components/TopBar.tsx");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_700_000_000_000;

describe("saying how old a reading is", () => {
  test("a normal cycle is not staleness", () => {
    // The server refreshes upstream every 15 minutes and the browser polls the
    // server every 5, so twenty minutes old is a healthy reading, not a stuck
    // one — and a strip that cried stale every cycle would teach you to stop
    // reading it.
    expect(stalenessLabel(NOW, NOW)).toBe(null);
    expect(stalenessLabel(NOW - 20 * MIN, NOW)).toBe(null);
    expect(STALE_AFTER_MS).toBeGreaterThan(20 * MIN);
  });

  test("past that it says the age, coarsely", () => {
    expect(stalenessLabel(NOW - 40 * MIN, NOW)).toBe("40m");
    expect(stalenessLabel(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(stalenessLabel(NOW - 23 * HOUR, NOW)).toBe("23h");
    expect(stalenessLabel(NOW - 50 * HOUR, NOW)).toBe("2d");
  });

  test("a clock that stepped backwards is not staleness", () => {
    // A resume or an NTP correction can put the reading in the future. That is
    // not something to shout about on a status strip.
    expect(stalenessLabel(NOW + 5 * MIN, NOW)).toBe(null);
  });
});

describe("the strip keeps answering the question it exists to answer", () => {
  test("the meters take the age rather than being replaced by a word", () => {
    expect(bar).toContain("pct={w.usedPercent} age={age}");
    // The age comes from when the reading was taken, which is what the server
    // preserves across a failed refresh — and for Codex is the last turn that
    // ran, which can be days back.
    expect(bar).toContain("stalenessLabel(u.observedAt)");
  });

  test("a stale meter is legible as stale without losing its number", () => {
    expect(bar).toContain("${tag} · ${age} old");
    expect(bar).toContain("opacity: age ? 0.55 : 1");
  });

  test('"no reading" is only reachable with no reading at all', () => {
    // It lives in the `!u.available` arm. The fix is not that the word is gone,
    // it is that the server almost always has something for the other arm — so
    // the word now means what it says. It replaced "rate-limited" when the
    // meters stopped being Anthropic's alone: 429 is one of several reasons a
    // provider has nothing to say, and the provider's own sentence — in the
    // tooltip here, in full on the dashboard box and in Stats — tells them
    // apart instead of guessing.
    expect(bar).toContain("const unread = !!u && !u.available");
    expect(bar).toContain("title={u?.note ??");
  });

  test("the meters follow the agent you are driving, not one vendor", () => {
    expect(bar).toContain("providerInContext(");
    expect(bar).toContain("usageOf(ctx)");
  });
});

// The per-model weekly window — the "Fable" bar. Drawn from whatever the API
// called it rather than from a list of model names kept here, because a strip
// that only knows last quarter's models quietly stops mentioning your limits.
describe("weekly windows scoped to one model", () => {
  const providers = read("../server/src/providerusage.ts");

  test("the strip draws one meter per window the provider reports", () => {
    // Scoped windows stopped being a second list the strip has to know about:
    // the server folds them into `windows`, so the bar draws whatever came
    // back and a new bucket needs no change here.
    expect(bar).toContain("u?.windows.map((w) => (");
    expect(bar).toContain("tag={w.label} pct={w.usedPercent} age={age}");
    // No model name may DECIDE anything — mentioning one in a comment is fine,
    // branching on one is the thing that goes stale.
    expect(bar).not.toMatch(/label\s*===\s*['"]/);
    expect(bar).not.toContain('tag="FABLE"');
  });

  test("the server carries them through, labelled by the API", () => {
    expect(providers).toContain("for (const s of u.scoped ?? [])");
    expect(providers).toContain("label: s.name");
    expect(providers).not.toMatch(/s\.name\s*===\s*['"]/);
  });

  test("they carry the same staleness marking as the rest", () => {
    // A scoped meter going stale silently while the ones beside it say so would
    // be worse than not drawing it. One list means one call site, so this is
    // now "the call site carries the age" — and that no second one appeared
    // beside it without it.
    const meters = bar.match(/<PlanMeter[\s\S]*?\/>/g) ?? [];
    expect(meters.length).toBeGreaterThanOrEqual(1);
    for (const m of meters) expect(m).toContain("age={age}");
  });
});

// The bar is one 30px row that must not wrap, so everything variable-length in
// it is bounded. The notch enforced this with a max-width on the strip itself;
// the bar has no strip to cap, so each thing that can grow caps itself.
describe("nothing in the bar can drag it off the screen", () => {
  const notes = read("src/components/TopBarNotes.tsx");

  test("a passing message is bounded and truncates", () => {
    expect(notes).toContain('maxWidth: "min(46vw, 460px)"');
    expect(notes).toContain("truncate");
  });

  test("so is the chip that says what wants you", () => {
    // Its reason is the agent's own text, which is the one string here with no
    // length anyone controls.
    expect(bar).toContain('maxWidth: "min(52vw, 520px)"');
  });

  test("the row never wraps, whatever is in it", () => {
    expect(bar).toContain("flex-nowrap");
    expect(bar).toContain("whitespace-nowrap");
  });
});
