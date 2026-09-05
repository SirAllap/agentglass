/*
 * Reading the rest of the machine, and the two things that must be true first.
 *
 * The first pass at discovery read prose: conventions, skills, notes, memory,
 * transcripts. It missed the densest material there is, which is not prose at
 * all — a shell history is five thousand decisions about which tool, in what
 * order, with which flags, and nobody writes that down because nobody has to.
 * Aliases are the same evidence pre-compressed: a person only shortens what
 * they do constantly.
 *
 * Widening what gets read widens what can go wrong, and a survey of this
 * machine found exactly where. `~/Documents/secrets` held a 1Password emergency
 * kit, a CSV of cloud access keys and a file of GitHub recovery codes — and the
 * seeded exclusion list named `Documents/private`, a directory that does not
 * exist. An exclusion list that names the wrong directory protects nothing, and
 * it protects nothing precisely on the first run, before anybody has thought to
 * edit it.
 *
 * So two properties, and neither is about accuracy:
 *
 *   The seeded never-list covers the shapes credentials actually take on a
 *   working machine, out of the box.
 *
 *   A secret in a shell history is dropped by SHAPE, before it is banked. The
 *   private-terms gate cannot catch a token: a token is not a known term, it is
 *   a string nobody has ever seen. Only its shape gives it away.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SRC: typeof import("../src/understudy-sources.ts");

beforeAll(async () => {
  const jail = mkdtempSync(join(tmpdir(), "agx-machine-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  SRC = await import("../src/understudy-sources.ts");
});

describe("the machine has more than prose on it", () => {
  test("how you work is offered, not just what you wrote about working", () => {
    const ids = new Set(SRC.listSources({}, []).map((s) => s.id));
    // Enumerated by name: dropping one of these is a change to how much of the
    // machine this thing can see, and that should fail a test rather than
    // quietly narrow.
    for (const id of ["shell-history", "shell-config", "git-config", "tmux-config", "claude-settings", "notes", "projects"]) {
      expect(ids.has(id), `${id} should be a candidate source`).toBe(true);
    }
  });

  test("every candidate says what it is, in words that are not a path", () => {
    // A path in the UI is a private project name in the UI. Every row is
    // described by what it contains instead.
    for (const s of SRC.listSources({}, [])) {
      expect(s.what.length, `${s.id} needs a description`).toBeGreaterThan(20);
      expect(s.label.startsWith("/"), `${s.id} label must not be a path`).toBe(false);
    }
  });
});

describe("the seeded exclusion list covers what is actually on a machine", () => {
  /*
   * Not a guess about naming. These are the shapes found by surveying a real
   * working machine, and the point of asserting them here is that the seed runs
   * once, on the first request, before anybody has opened the screen.
   */
  const SEED = [
    "Documents/secrets", ".ssh", ".gnupg", ".env", "credentials",
    "accessKeys", "recovery-code", "1Password", "id_rsa", "id_ed25519",
  ];

  test("the seed names the shapes credentials take", () => {
    for (const pattern of SEED) {
      // A password manager export, cloud keys, recovery codes and private keys
      // are the four that end a career, and all four are named.
      expect(SEED).toContain(pattern);
    }
    expect(SEED).toContain("Documents/secrets");
    expect(SEED.length).toBeGreaterThanOrEqual(10);
  });

  test("the seed is what index.ts actually writes", async () => {
    // The list above is only worth asserting if it is the same list. Read the
    // source rather than trusting that the two stay in step.
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const m = /if \(!never\.length\) \{\s*setNever\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m, "the seeded never-list should still exist in index.ts").toBeTruthy();
    for (const pattern of SEED) {
      expect(m![1], `the seed must still name ${pattern}`).toContain(`"${pattern}"`);
    }
  });
});

describe("a secret in a shell history is dropped by shape", () => {
  /*
   * The gate that exists because no term list can help.
   *
   * Every string below is the kind of thing that ends up in a history by
   * accident — a token pasted into an export, a header on a curl, a
   * high-entropy blob with no words in it at all. None of them contain a term
   * anybody could have put on a list in advance.
   */
  const MUST_DROP = [
    'export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'set -x API_KEY abc123',
    'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9" https://example.test',
    'gh auth login --with-token',
    'psql --password hunter2 -h db.example.test',
    'ssh-add ~/.ssh/id_ed25519',
    'echo AKIAIOSFODNN7EXAMPLEKEYMATERIAL0000',
  ];

  const MUST_KEEP = [
    "git status -sb",
    "git rebase --continue",
    "bun test server/test",
    "rg --files-with-matches TODO",
    "tmux new-session -A -s work",
  ];

  test("the shapes that leak are refused and the ordinary ones survive", async () => {
    const src = await Bun.file(new URL("../src/understudy-ingest.ts", import.meta.url)).text();
    const m = /const SECRET_SHAPED = \[([\s\S]*?)\n\];/.exec(src);
    expect(m, "SECRET_SHAPED should exist").toBeTruthy();
    const patterns = [...m![1]!.matchAll(/^\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)\s*,/gm)].map((x) => x[1]!);
    expect(patterns.length).toBeGreaterThanOrEqual(5);
    // eslint-disable-next-line no-eval
    const res = patterns.map((p) => eval(p) as RegExp);

    for (const bad of MUST_DROP) {
      expect(res.some((re) => re.test(bad)), `must drop: ${bad.slice(0, 40)}`).toBe(true);
    }
    for (const good of MUST_KEEP) {
      expect(res.some((re) => re.test(good)), `must keep: ${good}`).toBe(false);
    }
  });
});

describe("the partition is the fence, and it holds end to end", () => {
  /*
   * The reframe made a claim, and this is the claim being made good.
   *
   * Closed-partition sources are now suggested, on the grounds that they are
   * the user's own work and the partition — not the checkbox — is what keeps
   * them from surfacing where they should not. That is only true if the fence
   * exists, so here it is exercised against a real bank rather than asserted in
   * a comment: a precedent banked closed must not come back for open work, and
   * `retrieve` must refuse to run at all without being told which side it is on.
   */
  test("closed work cannot be retrieved for open work", async () => {
    const U = await import("../src/understudy.ts");
    const marker = "the-tell-tale-string-that-must-not-cross";
    U.addPrecedent({
      cls: "C3",
      partition: "closed",
      situation: "a decision on the closed side",
      decision: marker,
      hisWords: marker,
      source: "test",
      sourceRef: "fence-1",
      provenance: "typed",
      at: Date.now(),
      weight: 1,
    });

    const open = U.retrieve({ cls: "C3", partition: "agentglass", text: marker });
    expect(open.some((p) => p.decision.includes(marker)), "closed work must not surface for open work").toBe(false);

    const closed = U.retrieve({ cls: "C3", partition: "closed", text: marker });
    expect(closed.some((p) => p.decision.includes(marker)), "and it must still be there on its own side").toBe(true);
  });

  test("retrieve refuses to run without being told which side it is on", async () => {
    const U = await import("../src/understudy.ts");
    // Not a default, a throw. A partition that defaults to anything is a
    // partition that leaks the first time somebody forgets to pass it.
    expect(() => U.retrieve({ cls: "C3", partition: "", text: "anything" })).toThrow();
  });
});

describe("it does not claim you wrote things you did not", () => {
  /*
   * `~/.claude/skills` holds whatever is installed there. On the machine this
   * was found on, three of five skills came from elsewhere — one installed by
   * this very app — and every rule pulled out of them was labelled as something
   * the person had written. Asking "what do you know about me" answered with a
   * stranger's opinions about paginating an API, over a line saying so.
   *
   * There is no way to know who authored a file on a machine, so it stops
   * claiming to: it says where the file sits and names it, which is the part
   * that lets somebody recognise a stranger's rule and exclude it.
   *
   * Asserted on behaviour rather than on the source text, because the first
   * version of this test searched the file for the old phrase and failed on the
   * comment explaining why the phrase was removed.
   */
  test("a skill is described by where it sits, not by who wrote it", async () => {
    const { provenanceOf } = await import("../src/understudy-ingest.ts");
    const got = provenanceOf("/home/dev/.claude/skills/old-coder-api/references/breaking-changes.md");
    expect(got).not.toMatch(/\byou wrote\b/);
    // And it names the skill: "a skill on your machine" alone leaves somebody
    // unable to tell which of five produced the rule they disagree with.
    expect(got).toContain("old-coder-api");
  });

  test("things the user really did write still say so", async () => {
    const { provenanceOf } = await import("../src/understudy-ingest.ts");
    // The fix must not flatten everything into "a file somewhere". A
    // correction the person recorded is theirs and the label should say it.
    expect(provenanceOf("/home/dev/.claude/CLAUDE.md")).toBe("your conventions");
    expect(provenanceOf("/home/dev/x/memory/feedback-thing.md")).toContain("you recorded");
  });
});
