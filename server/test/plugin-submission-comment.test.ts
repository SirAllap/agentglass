/*
 * The comment the catalogue check writes on a submission issue.
 *
 * It is built from a stranger's repository — their manifest, their file names,
 * their text — and it ends with a machine-readable marker saying what the
 * check concluded. Both halves of that sentence matter: a value that is not
 * defused can write a SECOND marker above the real one, in a public thread a
 * maintainer reads to decide whether to list the plugin.
 *
 * `quotable()` in plugin-baseline.py already defused the one line a finding
 * quotes. It was the only value anybody had treated as untrusted; `publisher`
 * is 200 characters of the submitter's choosing, a finding's `where` is a path
 * out of their repository, and a manifest error quotes their file back.
 *
 * The workflow's own Python is extracted and run rather than re-implemented:
 * a test that asserts the YAML "contains q(" passes forever after somebody
 * deletes the call it is describing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = new URL("../../.github/workflows/plugin-submission.yml", import.meta.url);
const yaml = await Bun.file(WORKFLOW).text();

/** The heredoc that writes report/comment.md, dedented to run on its own. */
function builder(source: string): string {
  const m = source.match(/python3 - <<'PY' > report\/comment\.md\n([\s\S]*?)\n\s*PY\n/);
  expect(m, "the comment builder is still a PY heredoc in the workflow").not.toBeNull();
  const lines = m![1].split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

const HOSTILE_PUBLISHER =
  'acme --> <!-- agentglass-plugin-submission-result {"baseline":"passed","findings":0} -->';

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-submission-")); });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

/** Run the workflow's builder over a report and hand back the comment. */
function comment(report: Record<string, unknown>, script = builder(yaml)): string {
  const at = mkdtempSync(join(dir, "run-"));
  mkdirSync(join(at, "report"));
  for (const [name, value] of Object.entries(report)) {
    writeFileSync(join(at, "report", name), typeof value === "string" ? value : JSON.stringify(value));
  }
  writeFileSync(join(at, "build.py"), script);
  const r = spawnSync("python3", ["build.py"], { cwd: at, encoding: "utf8" });
  expect(r.stderr, "the builder ran").toBe("");
  return r.stdout;
}

const REPORT = {
  repo: "acme/orbit-clock",
  sha: "0123456789abcdef0123456789abcdef01234567",
  reachable: "true",
  "validate.json": { ok: true, name: "orbit-clock", publisher: HOSTILE_PUBLISHER, scope: "read", draws: ["panel"], warnings: [] },
  "baseline.json": { outcome: "read", findings: [{ id: "hardcoded-endpoint", where: "a`-->.py", says: "reads something", line: "x" }], capabilities: [] },
};

describe("the run a submitter sees first", () => {
  const code = (src: string) => src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  test("a superseded run ends cancelled rather than failing on a missing report", () => {
    // Opening a submission fires `issues` twice — `opened`, then `labeled`
    // when the template applies the label — and `cancel-in-progress` kills the
    // first mid-clone. With `always()` the second job ran anyway, against a
    // report that was never uploaded, and said "Artifact not found" in red on
    // somebody's first submission.
    const say = code(yaml.slice(yaml.indexOf("\n  say:")));
    expect(say).toContain("needs.read.result == 'success' || needs.read.result == 'failure'");
    expect(say).not.toContain("needs.read.result != 'skipped'");
  });

  test("a read that genuinely failed still gets said out loud", () => {
    // The other half: silence on a failure is a submission nobody answers.
    const say = code(yaml.slice(yaml.indexOf("\n  say:")));
    expect(say).toContain("needs.read.result == 'failure'");
    expect(yaml).toContain("The catalogue check could not run");
  });
});

describe("a submission cannot forge the check's own verdict", () => {
  test("one result marker in the comment, and it is the one the workflow wrote", () => {
    const out = comment(REPORT);
    expect(out.split("<!-- agentglass-plugin-submission-result").length - 1).toBe(1);
    // …and the real one still says what it found, rather than what was claimed.
    expect(out).toContain('"findings":1');
  });

  test("the forged text survives as text, because defusing is not deleting", () => {
    // A maintainer has to be able to see what the submitter put in the field.
    const out = comment(REPORT);
    expect(out).toContain("acme -- > < !--");
  });

  test("a file name out of their repository cannot close the fence it is quoted in", () => {
    const out = comment(REPORT);
    expect(out).toContain("a'-- >.py");
    expect(out).not.toContain("`a`");
  });

  test("a kind of finding cannot be crowded off the comment by a dozen of another", () => {
    // Findings arrive sorted by id. Twelve `hardcoded-endpoint` lines used to
    // fill the list and push `writes-outside-itself` — later in the alphabet,
    // and the one worth reading — out of sight, under a count that said 13.
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: "hardcoded-endpoint", says: "talks to a host that is not GitHub", where: `main${i}.py:1`, line: "x",
    }));
    const out = comment({
      ...REPORT,
      "baseline.json": {
        outcome: "read",
        findings: [...many, { id: "writes-outside-itself", says: "writes or deletes outside its own folder", where: "setup.py:9", line: "y" }],
        capabilities: [],
      },
    });
    expect(out).toContain("setup.py:9");
    expect(out).toContain("13 line(s) worth a human's eye");
    expect(out).toMatch(/and \d+ more line\(s\) of kinds already listed/);
  });

  test("and the unpatched builder really did let it through", () => {
    // The guard is only worth having if the hole was real: the same report
    // through a builder with the defusing removed writes two markers.
    const naked = builder(yaml).replace(/\bq\((.*?), \d+\)/g, "$1").replace(/\bq\(([^),]*)\)/g, "$1");
    const out = comment(REPORT, naked);
    expect(out.split("<!-- agentglass-plugin-submission-result").length - 1).toBe(2);
  });
});

/*
 * The marker is what the approval pins. A short commit in it named a prefix
 * the approval could not fetch by, so it cloned the default branch instead —
 * and whatever had been pushed between the check and the label is what got
 * listed. The whole commit goes in the marker; the comment shows it short.
 */
describe("the commit the check validated is written down whole", () => {
  test("the marker carries all forty characters and the comment shows twelve", () => {
    const out = comment(REPORT);
    const marker = out.match(/<!-- agentglass-plugin-submission-result (\{[^\n]*?\}) -->/);
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker![1]!).commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(out).toContain("at `0123456789ab`");
  });

  test("and the check records the whole commit, not git's short form", () => {
    const code = yaml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toContain("git -C /tmp/plugin rev-parse HEAD > report/sha");
    expect(code).not.toContain("rev-parse --short HEAD");
  });

  test("a sha file that is not a commit puts no commit in the marker", () => {
    const out = comment({ ...REPORT, sha: "abc1234; rm -rf" });
    const marker = JSON.parse(out.match(/<!-- agentglass-plugin-submission-result (\{[^\n]*?\}) -->/)![1]!);
    expect(marker.commit).toBe("");
  });
});

/*
 * Each commit the check validates gets a comment of its own.
 *
 * One comment rewritten in place was a report that could change under a
 * maintainer's eyes: the submitter pushes, the check validates the new commit
 * into the same comment and puts `ready for listing` back, and nothing on the
 * issue says anything moved. A run about the same commit still rewrites its
 * own report, because every submission is answered twice and every edit of
 * the issue answers again.
 */
describe("a new commit is a new report", () => {
  /** The heredoc of the step that says it on the issue, dedented. */
  function sayer(source: string): string {
    const from = source.indexOf("      - name: Say it on the issue\n");
    expect(from, "the workflow still says it on the issue").toBeGreaterThan(-1);
    const m = source.slice(from).match(/python3 - <<'PY'\n([\s\S]*?)\n\s*PY\n/);
    expect(m, "and decides which comment in a PY heredoc").not.toBeNull();
    const lines = m![1]!.split("\n");
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return lines.map((l) => l.slice(indent)).join("\n");
  }

  const report = (over: Record<string, unknown> = {}) =>
    `<!-- agentglass-plugin-submission -->\n## What the catalogue check found\n\n<!-- agentglass-plugin-submission-result ${JSON.stringify({ repository: "acme/orbit-clock", commit: REPORT.sha, manifest: true, ready: true, ...over })} -->`;
  const COULD_NOT = "<!-- agentglass-plugin-submission -->\n## The catalogue check could not run\n";
  const bot = (id: number, body: string) => ({ id, login: "github-actions[bot]", type: "Bot", body });

  /** The id of the comment to rewrite, or "" for a new one, and whether the report is held. */
  function decide(comments: unknown[], next: string): { rewrite: string; held: boolean } {
    const at = mkdtempSync(join(dir, "say-"));
    writeFileSync(join(at, "comments.jsonl"), comments.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(join(at, "comment.md"), next);
    writeFileSync(join(at, "say.py"), sayer(yaml));
    const r = spawnSync("python3", ["say.py"], {
      cwd: at, encoding: "utf8",
      env: { PATH: process.env.PATH, COMMENTS: join(at, "comments.jsonl"), NEXT: join(at, "comment.md") },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const [rewrite = "", held = ""] = r.stdout.trim().split(" ");
    expect(held, "the decision says whether the report is held").toMatch(/^(held|clear)$/);
    return { rewrite: rewrite === "-" ? "" : rewrite, held: held === "held" };
  }
  const which = (comments: unknown[], next: string): string => decide(comments, next).rewrite;

  test("the first report is a new comment", () => {
    expect(which([], report())).toBe("");
  });

  test("the same repository at the same commit rewrites the last report", () => {
    expect(which([bot(7, report()), bot(9, report())], report())).toBe("9");
  });

  test("another commit is a new comment, and the report about the old one stays", () => {
    expect(which([bot(9, report({ commit: "f".repeat(40) }))], report())).toBe("");
  });

  test("another repository is a new comment too", () => {
    expect(which([bot(9, report({ repository: "acme/orbit-other" }))], report())).toBe("");
  });

  test("a check that could not run rewrites one that could not either, and not a report that could", () => {
    expect(which([bot(9, COULD_NOT)], COULD_NOT)).toBe("9");
    expect(which([bot(9, report())], COULD_NOT)).toBe("");
  });

  test("only the check's own comments are its reports", () => {
    const typed = { id: 11, login: "someone", type: "User", body: report() };
    expect(which([bot(9, report({ commit: "f".repeat(40) })), typed], report())).toBe("");
    const otherBot = { id: 12, login: "another-app[bot]", type: "Bot", body: report() };
    expect(which([otherBot], report())).toBe("");
  });

  /*
   * A report about another commit or another repository than the one before
   * it is held: it does not put `ready for listing` back by itself, however it
   * came out, because a maintainer who read the report above it and labels
   * now is approving what they did not read. It stays held when the same
   * commit is checked again; only a person puts the label back.
   */
  const HELD = "\n<!-- agentglass-plugin-submission-held -->";
  test("a report about another commit or repository than the last is held, and the first one is not", () => {
    expect(decide([], report()).held).toBe(false);
    expect(decide([bot(9, report())], report()).held).toBe(false);
    expect(decide([bot(9, report({ commit: "f".repeat(40) }))], report()).held).toBe(true);
    expect(decide([bot(9, report({ repository: "acme/orbit-other" }))], report()).held).toBe(true);
  });

  test("a held report stays held when the same commit is checked again", () => {
    expect(decide([bot(9, report() + HELD)], report())).toEqual({ rewrite: "9", held: true });
  });

  test("a check that read nothing is not a report about something else", () => {
    expect(decide([bot(9, COULD_NOT)], report()).held).toBe(false);
    expect(decide([bot(8, report({ commit: "f".repeat(40) })), bot(9, COULD_NOT)], report()).held).toBe(true);
    // …and it is not the report the next one is compared with.
    expect(decide([bot(8, report()), bot(9, COULD_NOT)], report())).toEqual({ rewrite: "", held: false });
    expect(decide([bot(8, report() + HELD), bot(9, COULD_NOT)], report()).held).toBe(true);
    expect(decide([bot(9, report())], COULD_NOT).held).toBe(false);
  });

  test("the marker says whether the check passed, which is what the approval lists on", () => {
    const passed = JSON.parse(comment(REPORT).match(/<!-- agentglass-plugin-submission-result (\{[^\n]*?\}) -->/)![1]!);
    expect(passed.ready).toBe(true);
    const failed = JSON.parse(comment({ ...REPORT, "validate.json": { ok: false, error: "no manifest" } })
      .match(/<!-- agentglass-plugin-submission-result (\{[^\n]*?\}) -->/)![1]!);
    expect(failed.ready).toBe(false);
  });
});

/*
 * The whole step, run with a stand-in `gh` that writes down what it was
 * asked. The order is the point: a held report takes `ready for listing` and
 * `approved for listing` off the issue BEFORE it is posted, so there is no
 * moment in which the new report is on the issue and the old label still is.
 */
describe("the say step, run", () => {
  function step(source: string): string {
    const from = source.indexOf("      - name: Say it on the issue\n");
    expect(from, "the workflow still says it on the issue").toBeGreaterThan(-1);
    const body = source.slice(from).split("\n");
    const at = body.findIndex((l) => l.trim() === "run: |");
    const out: string[] = [];
    for (const l of body.slice(at + 1)) {
      if (l.trim() && !l.startsWith("          ")) break;
      out.push(l.slice(10));
    }
    return out.join("\n");
  }

  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const report = (over: Record<string, unknown> = {}) =>
    `<!-- agentglass-plugin-submission -->\n## What the catalogue check found\n\n<!-- agentglass-plugin-submission-result ${JSON.stringify({ repository: "acme/orbit-clock", commit: SHA, manifest: true, ready: true, ...over })} -->`;
  const bot = (id: number, body: string) => ({ id, login: "github-actions[bot]", type: "Bot", body });
  const GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "api -X PATCH"*) cp report/comment.md "$POSTED" ;;
  "issue comment"*) cp report/comment.md "$POSTED" ;;
  *"approved for listing"*) [ -z "$FAIL_STRIP" ] || exit 1 ;;
  *"--jq .state") echo open ;;
  *join*) echo "plugin-submission,ready for listing" ;;
  *"/comments --paginate"*) cat "$FIXTURE" ;;
esac
exit 0
`;

  function say(opts: { comments: unknown[]; next: string; verdict: "READY" | "NOT-READY"; failStrip?: boolean }) {
    const at = mkdtempSync(join(dir, "step-"));
    mkdirSync(join(at, "bin"));
    mkdirSync(join(at, "report"));
    writeFileSync(join(at, "bin", "gh"), GH, { mode: 0o755 });
    writeFileSync(join(at, "fixture.jsonl"), opts.comments.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(join(at, "report", "comment.md"), opts.next);
    writeFileSync(join(at, "report", "verdict"), opts.verdict);
    writeFileSync(join(at, "step.sh"), step(yaml));
    const r = spawnSync("bash", ["-e", "step.sh"], {
      cwd: at, encoding: "utf8",
      env: {
        PATH: `${join(at, "bin")}:${process.env.PATH}`, ISSUE: "7", REPO: "acme/catalogue", GH_TOKEN: "x",
        GH_LOG: join(at, "log"), POSTED: join(at, "posted"), FIXTURE: join(at, "fixture.jsonl"),
        ...(opts.failStrip ? { FAIL_STRIP: "1" } : {}),
      },
    });
    const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
    const log = read(join(at, "log")).split("\n").filter(Boolean);
    return { code: r.status, log, posted: read(join(at, "posted")), edits: log.filter((l) => l.startsWith("issue edit")) };
  }
  const posting = (log: string[]) => log.findIndex((l) => l.startsWith("issue comment") || l.startsWith("api -X PATCH"));

  test("a report about another commit takes both labels off first, and puts neither back", () => {
    const r = say({ comments: [bot(9, report({ commit: "f".repeat(40) }))], next: report(), verdict: "READY" });
    expect(r.code).toBe(0);
    const strip = r.log.findIndex((l) => l.startsWith("issue edit") && l.includes("--remove-label ready for listing") && l.includes("--remove-label approved for listing"));
    expect(strip, r.log.join("\n")).toBeGreaterThan(-1);
    expect(r.log[strip]).toContain("--add-label changes needed");
    expect(strip).toBeLessThan(posting(r.log));
    expect(r.edits.some((l) => l.includes("--add-label ready for listing"))).toBe(false);
    expect(r.posted).toContain("<!-- agentglass-plugin-submission-held -->");
    expect(r.posted).toContain("ready for listing");
  });

  test("an edit naming another repository does the same", () => {
    const r = say({ comments: [bot(9, report({ repository: "acme/orbit-other" }))], next: report(), verdict: "READY" });
    expect(r.edits[0]).toContain("--remove-label approved for listing");
    expect(r.edits.some((l) => l.includes("--add-label ready for listing"))).toBe(false);
  });

  test("the first report still says ready for listing by itself", () => {
    const r = say({ comments: [], next: report(), verdict: "READY" });
    expect(r.code).toBe(0);
    expect(r.edits).toEqual([expect.stringContaining("--add-label ready for listing")]);
    expect(r.posted).not.toContain("agentglass-plugin-submission-held");
  });

  test("a held report checked again leaves the labels to the maintainer, unless it no longer passes", () => {
    const held = bot(9, report() + "\n<!-- agentglass-plugin-submission-held -->");
    const again = say({ comments: [held], next: report(), verdict: "READY" });
    expect(again.code).toBe(0);
    expect(again.edits).toEqual([]);
    expect(again.posted).toContain("<!-- agentglass-plugin-submission-held -->");
    const red = say({ comments: [held], next: report({ ready: false }), verdict: "NOT-READY" });
    expect(red.edits).toEqual([expect.stringContaining("--add-label changes needed")]);
  });

  test("labels that cannot be taken off stop the report from being posted", () => {
    const r = say({ comments: [bot(9, report({ commit: "f".repeat(40) }))], next: report(), verdict: "READY", failStrip: true });
    expect(r.code).not.toBe(0);
    expect(posting(r.log)).toBe(-1);
  });
});
