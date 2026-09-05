/**
 * The title block, in every state somebody lands in.
 *
 * A drawing carries a block naming the project, the scale and the revision. It
 * is in the same place on every sheet and you read it before the drawing. This
 * panel authorises work somebody will not watch happen, inside a boundary that
 * has to hold — the same problem, so the same device.
 *
 * It replaces three separate things: a first-run step strip, a "may work in"
 * line, and the run bar's status sentence. Those were three answers to one
 * question — what is set up, what is queued, what happens if I press this —
 * and a person had to assemble it from three places on the screen.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { titleBlock, stampFor } from "../src/components/understudy/Work.tsx";

const idle = { project: "agentglass", checkouts: 3, queued: 0, cutting: false, minsLeft: 0, sheetsLeft: 0 };

describe("the block", () => {
  test("always three fields, always in this order", () => {
    for (const s of [idle, { ...idle, queued: 3 }, { ...idle, cutting: true, minsLeft: 38, sheetsLeft: 2 }, { ...idle, project: "" }]) {
      const b = titleBlock(s);
      expect(Object.keys(b), "the block must not change shape between states").toEqual(["where", "what", "after"]);
      for (const f of [b.where, b.what, b.after]) {
        expect(f.k.length, "every field is labelled").toBeGreaterThan(2);
        expect(f.v.length, "every field has a value, even when the value is 'none'").toBeGreaterThan(0);
      }
    }
  });

  test("no fence is the lit cell, because every control below will refuse", () => {
    const b = titleBlock({ ...idle, project: "", checkouts: 0, queued: 5 });
    expect(b.where.lit, "an unset fence is not a quiet default").toBe(true);
    expect(b.where.v).toBe("nowhere yet");
    expect(b.where.sub).toContain("decline");
    // …and the queue is NOT lit while the fence is unanswered.
    expect(b.what.lit).toBe(false);
  });

  test("with a fence and sheets, the set is what is lit", () => {
    const b = titleBlock({ ...idle, queued: 3 });
    expect(b.what.lit).toBe(true);
    expect(b.what.v).toBe("3");
    expect(b.where.lit).toBe(false);
  });

  test("an empty set says so, and does not light", () => {
    const b = titleBlock(idle);
    expect(b.what.v).toBe("none");
    expect(b.what.sub).toContain("add one");
    expect(b.what.lit).toBe(false);
  });

  test("cutting changes the VALUES, never the shape", () => {
    const b = titleBlock({ ...idle, cutting: true, minsLeft: 38, sheetsLeft: 2, queued: 3 });
    expect(b.where.k).toBe("cutting in");
    expect(b.what.v).toBe("2");
    expect(b.after.k).toBe("time on the clock");
    expect(b.after.v).toBe("38 min");
    expect(b.after.lit, "while it runs, the clock is the live cell").toBe(true);
  });

  test("one checkout is singular", () => {
    expect(titleBlock({ ...idle, checkouts: 1 }).where.sub).toBe("1 checkout");
    expect(titleBlock({ ...idle, checkouts: 3 }).where.sub).toBe("3 checkouts");
  });

  test("exactly one cell is lit at a time", () => {
    for (const s of [idle, { ...idle, queued: 2 }, { ...idle, project: "" }, { ...idle, cutting: true, minsLeft: 5, sheetsLeft: 1 }]) {
      const b = titleBlock(s);
      const lit = [b.where, b.what, b.after].filter((f) => f.lit).length;
      expect(lit, "two lit cells is two places to look").toBeLessThanOrEqual(1);
    }
  });
});

describe("the stamp", () => {
  test("three words replace four states", () => {
    expect(stampFor("done").word).toBe("approved");
    expect(stampFor("running").word).toBe("cutting");
    expect(stampFor("abandoned").word).toBe("on hold");
    // failed and uncommitted mean the same thing to a reader: the sheet is kept
    // and it is not to be built from.
    for (const s of ["failed", "uncommitted"]) expect(stampFor(s).word).toBe("void");
    /*
     * `empty` is the fourth, and it earned its own word the morning the
     * register settled nineteen interrupted runs at once. A run whose branch is
     * gone left nothing to build from — the register's definition of void — but
     * printing twenty of them in the same red as a failure says "it all went
     * wrong" about a night where almost nothing did.
     */
    expect(stampFor("empty").word).toBe("nothing left");
  });

  test("red is reserved — only void takes the error colour", () => {
    expect(stampFor("failed").tone).toBe("error");
    expect(stampFor("done").tone).toBe("success");
    expect(stampFor("abandoned").tone, "interrupted is nobody's fault").toBe("warning");
    expect(stampFor("empty").tone, "nothing to do is not the same as something went wrong").not.toBe("error");
  });

  test("an unknown state still stamps something rather than rendering blank", () => {
    expect(stampFor("something-new").word).toBe("void");
  });
});

test("the revision cloud is drawn around the row, not filled in — and it closes", () => {
  /*
   * A set with one question in it still has to read as a set. A full-width
   * coloured banner takes the screen; a scalloped outline marks one row.
   *
   * And the outline has to be an outline. The scallop is a repeating tile over
   * the border, and a box of arbitrary width never holds a whole number of
   * tiles — so it was cut at the right edge and the bottom, the corners did not
   * meet, and on a wide short banner the frame read as a dashed rectangle
   * somebody had broken. "The UI is a bit broken." A faint continuous outline
   * underneath closes the shape at any size; the scallop rides over it.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const at = css.indexOf(".agx-cloud::before");
  expect(at).toBeGreaterThan(-1);
  const under = css.slice(at, css.indexOf("}", at));
  expect(under, "the continuous outline that closes it").toContain("border: 1.5px solid color-mix");
  expect(under, "a filled cloud is a banner").not.toContain("background:");

  const over = css.slice(css.indexOf(".agx-cloud::after"), css.indexOf("}", css.indexOf(".agx-cloud::after")));
  expect(over).toContain("border: 1.5px solid var(--error)");
  expect(over, "the scallops are a mask, not a background").toContain("mask:");
  expect(over, "a filled cloud is a banner").not.toContain("background:");
});

/**
 * The rest of the set: the reading sheet, the schedule of sources, and the
 * boundary. Same shape as the work tab — a headline, the evidence, the prose
 * behind a mark.
 */
describe("the reading sheet", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/Ask.tsx", import.meta.url), "utf8");

  test("one finding with a margin, not four equal headings", () => {
    /* Before: closest match / also in what you wrote / what you recorded /
       what you said at the time — four headings, same size, same colour, and
       the answer was the first paragraph of the first one. */
    expect(SRC, "the reading uses the same block the work tab does").toContain('className="agx-tb"');
    expect(SRC).toContain("Finding");
    expect(SRC).toContain("Drawn from");
  });

  test("and it certifies who wrote it", () => {
    expect(SRC).toContain("nothing written by it");
    expect(SRC, "the certification is a stamp, like the register's").toContain("agx-stamp");
  });

  test("the four shouting eyebrows are gone", () => {
    const at = SRC.indexOf("The reference that settles it");
    expect(at, "the closest match got a name that says what it is").toBeGreaterThan(-1);
    expect(SRC).not.toContain('panel-eyebrow">Closest match');
  });
});

describe("the schedule of sources", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/Teach.tsx", import.meta.url), "utf8");

  test("a bar scaled against the largest, not a raw byte count", () => {
    expect(SRC).toContain("biggest");
    expect(SRC, "a list of empty sources must not divide by zero").toContain("Math.max(1,");
  });

  test("the paragraph and the path move to the row's hover", () => {
    const at = SRC.indexOf("s.found && s.bytes > 0");
    const row = SRC.slice(at, at + 900);
    expect(row).toContain("title={`${s.what}");
    expect(row).toContain("s.path");
  });

  test("private sources are drawn in their own colour, not the accent", () => {
    const at = SRC.indexOf("s.found && s.bytes > 0");
    expect(SRC.slice(at, at + 900)).toContain('s.sensitive ? "var(--phone)"');
  });
});

describe("the boundary", () => {
  const SRC = readFileSync(new URL("../src/components/understudy/Work.tsx", import.meta.url), "utf8");

  test("projects are picked from a list, not typed into an empty box", () => {
    expect(SRC).toContain("projects.map");
    expect(SRC, "each row says what choosing it opens up, before it is chosen").toContain("checkouts`");
  });

  test("typing survives as the escape hatch", () => {
    expect(SRC).toContain("a project this machine has not seen yet");
  });

  test("picking and typing go through ONE path", () => {
    /* The server refuses a name that matches every checkout on the machine. A
       picked row has to meet that rule exactly as a typed one does. */
    expect(SRC).toContain("const renameTo = async");
    expect(SRC).toContain("void renameTo(p.name)");
  });
});
