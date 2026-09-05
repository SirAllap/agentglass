/*
 * The judge, and the three things that make it safe to have at all.
 *
 * Counting answers "what did he do the last nine times this exact shape came
 * up", and answers it well. What it cannot do is generalise — a situation
 * nobody classified, a card written this morning — and for those the tables
 * correctly decline. Declining forever is not standing in for somebody, so
 * there is a reader of last resort.
 *
 * A reader. Not an actor, and the difference is enforced rather than intended:
 *
 *   NO TOOLS. Empty allowlist, a prompting permission mode, and no terminal to
 *   prompt at. A tool call cannot succeed even if one were attempted, and
 *   `--dangerously-skip-permissions` is absent and must stay absent.
 *
 *   OFF BY DEFAULT. Everything else runs on this machine; this sends a prompt
 *   somewhere. He uses that channel by hand every day — which is why it is the
 *   channel rather than a new service with a new key — but him typing into it
 *   and this app doing so unattended are different acts, and the second is his
 *   to switch on.
 *
 *   IT DECLINES RATHER THAN INVENTS. With nothing of his to reason from it does
 *   not ask at all: a fluent answer about nobody in particular, signed with his
 *   name, is the exact failure this feature exists to prevent.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let J: typeof import("../src/understudy-judge.ts");
let U: typeof import("../src/understudy.ts");

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), "agx-judge2-"));
  mkdirSync(join(d, "config", "git"), { recursive: true });
  writeFileSync(join(d, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(d, "t.db");
  process.env.XDG_CONFIG_HOME = join(d, "config");
  U = await import("../src/understudy.ts");
  J = await import("../src/understudy-judge.ts");
  // Pinned, not inherited: the terms path is module state shared by every
  // suite in the process, and a suite before this one may have pointed it at
  // a file that does not exist (its own "no list" case) and left it there —
  // measured on the CI runner as "there is no private-terms list" where this
  // file expected "nothing of yours".
  U.__setPrivateTermsPath(join(d, "config", "git", "private-terms.txt"));
});

describe("it is off until somebody says otherwise", () => {
  test("a fresh install does not ask a model anything", () => {
    expect(U.judgeEnabled()).toBe(false);
  });

  test("and with it off, judging declines without spawning", async () => {
    const v = await J.judge({ situation: "anything at all", cls: "C1", partition: "agentglass" });
    expect(v.declined).toBe(true);
    expect(v.why).toMatch(/switched off/i);
  });

  test("switching it on is one explicit call", () => {
    expect(U.setJudge(true)).toBe(true);
    expect(U.judgeEnabled()).toBe(true);
    U.setJudge(false);
    expect(U.judgeEnabled()).toBe(false);
  });
});

describe("it cannot act, and that is in the argv", () => {
  test("no tools, no permission bypass, and nowhere to work", async () => {
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    const argv = src.slice(src.indexOf("const argv = ["), src.indexOf("];", src.indexOf("const argv = [")));
    // Enumerated, because each of these is a decision somebody could quietly
    // reverse while "improving" the prompt.
    expect(argv).toContain('"--allowedTools", ""');
    expect(argv).toContain('"--permission-mode", "default"');
    expect(argv).not.toContain("dangerously-skip-permissions");
    // And it runs in a private room of its own (0700, made per call, removed
    // after), never a world-writable directory where another local process
    // could plant a CLAUDE.md or a hooks file the CLI would read from cwd.
    expect(src).toContain("cwd: room.cwd");
    expect(src).not.toContain('cwd: "/tmp"');
    expect(src).toContain("mkdtempSync");
  });

  test("the whole file never reaches for a repository path", async () => {
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    expect(src).not.toMatch(/\bworktree\b|\bworkspaceRoot\b|\bgit\b\s*\(/);
  });
});

describe("it declines rather than inventing", () => {
  test("with nothing of his on the subject it does not even ask", async () => {
    U.setJudge(true);
    const v = await J.judge({ situation: "zzqq nothing here", cls: "C9", partition: "agentglass" });
    expect(v.declined).toBe(true);
    // Specifically this reason: it must be "I have nothing of yours", not a
    // model's polite hedge, because the two mean different things.
    expect(v.why).toMatch(/nothing of yours/i);
    U.setJudge(false);
  });

  test("a reply that is not the shape it asked for is a decline, not a guess", async () => {
    // The parser fails closed. Interpreting free text here is precisely where a
    // "no" quietly becomes a "yes".
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    expect(src).toContain("the reply was not the shape it was asked for");
    expect(src).toContain("declined: true");
  });
});

describe("nothing private leaves this machine", () => {
  /*
   * THE ONLY PATH IN THIS FEATURE THAT REACHES A NETWORK, and for a while the
   * only one that did not check what was on it.
   *
   * Everything else the understudy holds went through the private-terms gate on
   * its way into the bank. The judge read from the bank — already clean — and
   * then added two things that had never been near the gate: file PATHS off the
   * working tree, and the subjects of recent commits. On a machine where the
   * scope has been widened to somebody's real work, that is a repository layout
   * and a list of ticket numbers going to a model.
   *
   * Not a catastrophe, and not defensible either. The gate exists so that
   * nobody has to decide in the moment which of those it is.
   */
  test("every piece of the prompt has been through the gate", async () => {
    /*
     * THE PATHS AND COMMIT SUBJECTS THIS USED TO NAME went with the commit
     * drafter, which the work loop made redundant — the agent writes its own
     * commits now. The property did not go anywhere: this is the one path in
     * the whole feature that reaches a network, so nothing may be assembled
     * into it that has not been filtered first.
     *
     * Asserted as "no raw field survives into the prompt" rather than by
     * listing today's fields. A list is exactly what let a hard-coded project
     * name sit in the ingest for weeks — the guard has to cover the field
     * somebody adds tomorrow.
     */
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    const build = src.slice(src.indexOf("function buildPrompt"), src.indexOf("function parseVerdict"));

    // The question a person typed, and their own past words. Both filtered
    // BEFORE assembly: a gate applied to the finished string has already been
    // handed the thing it was guarding.
    expect(build).toContain("safeLines([q.situation])");
    expect(build).toContain("safeLines(cases.map(");

    /*
     * And nothing else from `q` or `cases` reaches the returned array raw.
     * Every interpolation of a field has to be of a name that safeLines
     * produced — `situation` and `said` — not of `q.…` or `c.…` directly.
     */
    const assembled = build.slice(build.indexOf("return ["));
    expect(assembled, "a raw q.* field must not be interpolated").not.toMatch(/\$\{q\.(?!cls\b)/);
    expect(assembled, "a raw case field must not be interpolated").not.toMatch(/c\.(hisWords|decision|situation)/);
  });

  test("dropped, never shortened", async () => {
    /*
     * A line that still trips the gate after translation does not go in a
     * masked form — it does not go. Half a sentence with the identifying half
     * removed is a judgement about which half identified it, and making that
     * judgement is exactly what the gate is there to avoid.
     */
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    const fn = src.slice(src.indexOf("function safeLines"), src.indexOf("function termsReady"));
    expect(fn).toContain("continue");
    expect(fn).not.toMatch(/replace\(|slice\(|\.\.\./);
  });

  test("a situation that is entirely private is withheld, not sent thinner", async () => {
    /*
     * The commit drafter's version of this refused outright when every changed
     * path was private, because a message written from the survivors would
     * describe a different change from the one being committed. The judge's
     * equivalent is the situation line: filtered to nothing, it becomes a
     * marker rather than an empty string, so the model is never asked to
     * decide about a blank.
     */
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    expect(src).toContain('safeLines([q.situation])[0] ?? "(withheld)"');
  });

  test("no terms list means nothing is sent at all", async () => {
    /*
     * The same rule the ingest already follows. With no list there is no way to
     * tell "checked, clean" from "could not check", and the second is not
     * something to guess at on the one path that reaches a network.
     */
    const J2 = await import("../src/understudy-judge.ts");
    const U2 = await import("../src/understudy.ts");
    U2.setJudge(true);
    const before = U2.__privateTermsPath();
    U2.__setPrivateTermsPath("/nonexistent-terms-file-for-a-test.txt");
    try {
      const v = await J2.judge({ situation: "anything", cls: "C1", partition: "agentglass" });
      expect(v.declined).toBe(true);
      expect(v.why).toMatch(/private-terms list/i);
    } finally {
      U2.__setPrivateTermsPath(before);
      U2.setJudge(false);
    }
  });
});
