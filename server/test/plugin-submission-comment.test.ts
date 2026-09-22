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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
