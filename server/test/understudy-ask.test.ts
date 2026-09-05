/*
 * The bank, finally being read — and the two properties that make that safe.
 *
 * This exists because for the whole life of the feature `retrieve()` had no
 * callers. Nearly nine thousand precedents and twelve hundred rules were read
 * off somebody's machine, compiled, counted on a panel, and queried by nothing.
 * Everything the understudy knew about the person sat in a table nobody asked.
 *
 * Now something asks, and asking is the dangerous direction: reading was always
 * bounded by consent, but ANSWERING is where private material could come back
 * out attached to the wrong question. So two properties, and neither is about
 * how good the answers are:
 *
 *   It never crosses the partition. Closed work answers closed questions only,
 *   and the argument that decides which is required rather than defaulted.
 *
 *   It never invents. Every line it returns is something the person wrote. An
 *   understudy that produces a plausible opinion and attributes it to you is
 *   worse than one that says nothing, because from the outside the two are
 *   indistinguishable.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let U: typeof import("../src/understudy.ts");
let ASK: typeof import("../src/understudy-ask.ts");

const OPEN = "agentglass";
const CLOSED = "closed";

beforeAll(async () => {
  const jail = mkdtempSync(join(tmpdir(), "agx-ask-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  U = await import("../src/understudy.ts");
  ASK = await import("../src/understudy-ask.ts");

  const bank = (partition: string, decision: string, ref: string) =>
    U.addPrecedent({
      cls: "C3",
      partition,
      situation: "landing a branch",
      decision,
      hisWords: decision,
      source: "test",
      sourceRef: ref,
      provenance: "typed",
      at: Date.now(),
      weight: 1,
    });

  bank(OPEN, "squash the branch and delete it after merging", "open-1");
  bank(CLOSED, "the-closed-marker: never merge to master by hand", "closed-1");
});

describe("it answers from the right side of the partition", () => {
  test("a question about open work cannot surface closed material", () => {
    const a = ASK.ask({ text: "merge and delete the branch", partition: OPEN });
    const text = JSON.stringify([...a.decided, ...a.said]);
    expect(text).not.toContain("the-closed-marker");
  });

  test("and the closed side still answers its own questions", () => {
    const a = ASK.ask({ text: "merge to master by hand", partition: CLOSED });
    expect(JSON.stringify([...a.decided, ...a.said])).toContain("the-closed-marker");
  });

  test("the partition is required, not defaulted", () => {
    // A default here is a leak the first time somebody forgets the argument,
    // and it would be a silent one — the answer would simply be wrong material.
    expect(() => ASK.ask({ text: "anything", partition: "" })).toThrow();
  });
});

describe("a thing said in passing is not a thing decided", () => {
  /*
   * They were one list, and the mixing was the defect: a turn out of a
   * transcript appeared under a heading reading "what you actually did".
   * Measured against a real bank, "do I squash when I merge" answered with
   * "Complete the merge" — a phrase carrying the word and none of the meaning,
   * borrowing the authority of the notes beside it.
   */
  test("transcript turns never appear as recorded conclusions", async () => {
    const U = await import("../src/understudy.ts");
    U.addPrecedent({
      cls: "C3", partition: OPEN, situation: "a turn you typed",
      decision: "complete the merge", hisWords: "complete the merge",
      source: "transcripts:-home-dev-code-orbit", sourceRef: "t-1",
      provenance: "typed", at: Date.now(), weight: 1,
    });
    const a = ASK.ask({ text: "merge", partition: OPEN, limit: 12 });
    for (const p of a.decided) {
      expect(p.source.startsWith("transcripts:"), `${p.source} is conversation, not a conclusion`).toBe(false);
    }
    expect(a.said.some((p) => p.decision.includes("complete the merge"))).toBe(true);
  });
});

describe("it does not invent", () => {
  test("every precedent it returns is a row that was banked", () => {
    const a = ASK.ask({ text: "merge and delete the branch", partition: OPEN });
    for (const p of [...a.decided, ...a.said]) {
      const back = U.retrieve({ cls: p.cls, partition: OPEN, text: p.decision, limit: 24 });
      expect(back.some((r) => r.id === p.id), `${p.id} should be a real banked row`).toBe(true);
    }
  });

  test("with nothing to go on it says so rather than reaching", () => {
    const a = ASK.ask({ text: "zzqqxx nothing on this machine matches", partition: OPEN });
    expect(a.decided).toEqual([]);
    expect(a.said).toEqual([]);
    expect(a.rules).toEqual([]);
    expect(a.thin).toBe(true);
    // And the sentence has to admit it, because `thin` is a boolean nobody
    // reads and the sentence is what ends up on screen.
    expect(a.says.toLowerCase()).toMatch(/nothing|has not read/);
  });

  test("it reports what it is standing on, not a score", () => {
    // A bare count reads as a grade: six precedents looks like a good answer
    // and may be six near-identical lines from one afternoon.
    const a = ASK.ask({ text: "merge and delete the branch", partition: OPEN });
    expect(a.says.length).toBeGreaterThan(20);
    expect(a.says).not.toMatch(/\d+%/);
  });
});

describe("a question lands in the drawer its answer was filed in", () => {
  test("there is exactly one class table on the server", async () => {
    /*
     * There were briefly two — one in the ingest deciding where a row is filed,
     * one in `ask` deciding which drawer a question opens — and two copies of
     * thirteen regexes drift. This asserts the copies are gone rather than
     * asserting they still agree, because one table cannot disagree with
     * itself and a sync test only notices drift after it has happened.
     */
    for (const f of ["../src/understudy-ingest.ts", "../src/understudy-ask.ts"]) {
      const src = await Bun.file(new URL(f, import.meta.url)).text();
      expect(src, `${f} should import the class table, not redeclare it`).not.toContain("CLASS_WORDS: [string, RegExp][] = [");
    }
  });

  test("a question and a row about the same thing land in the same class", async () => {
    const U = await import("../src/understudy.ts");
    for (const [text, want] of [
      ["should I delete the worktree", "C1"],
      ["what goes in the commit message", "C2"],
      ["do I squash when I merge", "C3"],
      ["is this bot review worth a reply", "C4"],
      ["nothing in particular at all here", "general"],
    ] as const) {
      expect(ASK.classifyQuestion(text), text).toBe(want);
      expect(U.classify(text), text).toBe(want);
    }
  });
});
