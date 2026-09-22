/*
 * The approval workflow writes the catalogue entry that the app installs from.
 *
 * What it writes decides what a label approved. An entry that pinned nothing
 * approved a repository, and every push after the label reached every fresh
 * install with no check in between. An entry that could replace another's
 * source by naming the same id was a hijack shaped like an update. And a job
 * that could post the required check on its own commit was the only guard on
 * main, satisfied by the thing it guarded.
 *
 * The workflow's own Python is extracted and run over fixtures, the way the
 * submission comment is tested: a test that asserts the YAML "contains ref"
 * passes forever after somebody deletes the line it is describing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yaml = await Bun.file(new URL("../../.github/workflows/plugin-approve.yml", import.meta.url)).text();

/** The heredoc of the step that writes the entry, dedented to run alone. */
function writer(source: string): string {
  const from = source.indexOf("      - name: Write the entry\n");
  expect(from, "the workflow still has a step that writes the entry").toBeGreaterThan(-1);
  const step = source.slice(from, source.indexOf("\n      - name:", from + 1));
  const m = step.match(/python3 - <<'PY'\n([\s\S]*?)\n\s*PY\n/);
  expect(m, "and it is still a PY heredoc").not.toBeNull();
  const lines = m![1]!.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);
const OWNER = "SirAllap";

const listed = (id: string, url: string) => ({
  id, title: id, publisher: "acme", verified: false, scope: "read", draws: [],
  source: { kind: "git", url, ref: "fedcba9876543210fedcba9876543210fedcba98" },
  sha256: "b".repeat(64), description: "Already on the shelf.", categories: [], added: "2026-09-01",
});

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-approve-")); });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

type Run = { code: number | null; stderr: string; stdout: string; catalogue: { plugins: Record<string, unknown>[] }; refused: string; body: string };

function approve(opts: {
  source?: string; publisher?: string; name?: string; sha?: string;
  plugins?: unknown[]; hash?: unknown; baseline?: unknown; preview?: boolean;
}): Run {
  const at = mkdtempSync(join(dir, "run-"));
  const plugin = join(at, "plugin");
  mkdirSync(plugin);
  if (opts.preview) writeFileSync(join(plugin, "preview.png"), "png");
  const catalogue = join(at, "plugins.json");
  writeFileSync(catalogue, JSON.stringify({ name: "agentglass plugins", owner: OWNER, plugins: opts.plugins ?? [] }));
  writeFileSync(join(at, "validate.json"), JSON.stringify({
    ok: true, name: opts.name ?? "orbit-clock", publisher: opts.publisher ?? "acme", scope: "read", draws: ["panels"], warnings: [],
  }));
  writeFileSync(join(at, "hash.json"), JSON.stringify(opts.hash ?? { ok: true, sha256: HASH, files: 3 }));
  writeFileSync(join(at, "baseline.json"), JSON.stringify(opts.baseline ?? { outcome: "passed", findings: [], capabilities: [] }));
  writeFileSync(join(at, "write.py"), writer(yaml));
  const source = opts.source ?? "acme/orbit-clock";
  const r = spawnSync("python3", ["write.py"], {
    cwd: at, encoding: "utf8",
    env: {
      PATH: process.env.PATH, BODY: "### Category\n\nreview\n\n### What it does, in two or three sentences\n\nShows the time.\n",
      SOURCE: source, REPO_URL: `https://github.com/${source}`, SHA: opts.sha ?? SHA,
      PLUGIN: plugin, VALIDATE: join(at, "validate.json"), HASH: join(at, "hash.json"),
      BASELINE: join(at, "baseline.json"), CATALOGUE: catalogue, REFUSED: join(at, "refused"), PR_BODY: join(at, "body.md"),
    },
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    code: r.status, stderr: r.stderr, stdout: r.stdout,
    catalogue: JSON.parse(readFileSync(catalogue, "utf8")),
    refused: read(join(at, "refused")), body: read(join(at, "body.md")),
  };
}

describe("an approved entry names bytes, not a branch", () => {
  test("it pins the commit this run cloned and the hash of that tree", () => {
    const r = approve({ preview: true });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const e = r.catalogue.plugins[0]! as { source: { ref: string }; sha256: string; preview: string; verified: boolean };
    expect(e.source.ref).toBe(SHA);
    expect(e.sha256).toBe(HASH);
    expect(e.verified).toBe(false);
  });

  test("and the picture is the one at that commit, not whatever HEAD shows next week", () => {
    const e = approve({ preview: true }).catalogue.plugins[0]! as { preview: string };
    expect(e.preview).toBe(`https://raw.githubusercontent.com/acme/orbit-clock/${SHA}/preview.png`);
    expect(e.preview).not.toContain("/HEAD/");
  });

  test("a clone that did not resolve to a commit, or a tree that did not hash, lists nothing", () => {
    for (const r of [approve({ sha: "" }), approve({ sha: "main" }), approve({ hash: { ok: false, error: "x resolves outside the plugin directory" } })]) {
      expect(r.code).toBe(1);
      expect(r.catalogue.plugins).toHaveLength(0);
      expect(r.refused).not.toBe("");
    }
  });

  test("the pull request says the commit, the hash and what the scan found at it", () => {
    const r = approve({ baseline: { outcome: "findings", findings: [{ id: "escalates", where: "x.sh:1", says: "", line: "sudo" }] } });
    expect(r.body).toContain(SHA);
    expect(r.body).toContain(HASH);
    expect(r.body).toContain("escalates");
    expect(approve({ baseline: { outcome: "unreadable" } }).body).toContain("did not complete");
  });
});

describe("a submission cannot take another's place", () => {
  test("an id already listed from a different repository is refused, and the shelf is untouched", () => {
    const before = [listed("orbit-clock", "https://github.com/someone-else/orbit-clock")];
    const r = approve({ plugins: before });
    expect(r.code).toBe(1);
    expect(r.refused).toContain("already listed");
    expect(r.catalogue.plugins).toEqual(before);
  });

  test("the same repository listing a new version replaces its own entry", () => {
    const r = approve({ plugins: [listed("orbit-clock", "https://github.com/acme/orbit-clock.git")] });
    expect(r.code).toBe(0);
    expect(r.catalogue.plugins).toHaveLength(1);
    expect((r.catalogue.plugins[0]!.source as { ref: string }).ref).toBe(SHA);
  });

  test("the project's name, however it is spelled, is refused as a stranger's byline", () => {
    for (const publisher of ["agentglass", "AgentGlass Team", "agent-glass", "sirallap"]) {
      const r = approve({ publisher });
      expect(r.code, publisher).toBe(1);
      expect(r.refused).toContain("reserves");
      expect(r.catalogue.plugins).toHaveLength(0);
    }
  });

  test("and allowed from a repository under the catalogue's owner", () => {
    expect(approve({ publisher: "agentglass", source: "SirAllap/orbit-clock" }).code).toBe(0);
  });

  test("the refusal quotes the publisher defused, because it lands in a public comment", () => {
    const r = approve({ publisher: "agentglass `x` <!-- marker --> @someone" });
    expect(r.refused).not.toContain("`");
    expect(r.refused).not.toContain("<!--");
    expect(r.refused).not.toContain("@someone");
  });
});

describe("the job holds nothing it does not use", () => {
  /** The `list` job's permissions block, from its key to the first step. */
  const perms = yaml.slice(yaml.indexOf("    permissions:\n", yaml.indexOf("  list:")), yaml.indexOf("    steps:"));
  const code = yaml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  test("no status is written, so no check can be reported by the run it guards", () => {
    expect(perms).not.toContain("statuses:");
    expect(code).not.toContain("/statuses/");
    expect(code).not.toContain("context=build");
  });

  test("its own token cannot write the repository", () => {
    expect(perms).toContain("contents: read");
    expect(perms).not.toContain("contents: write");
  });

  test("the checkout keeps no credentials for a later step to find", () => {
    const co = code.slice(code.indexOf("uses: actions/checkout@"), code.indexOf("- name: Read the submission"));
    expect(co).toContain("persist-credentials: false");
  });

  test("the clone is hashed with the CLI and scanned again before it is listed", () => {
    expect(code).toContain("python3 bin/agentglass-plugin hash /tmp/plugin > /tmp/hash.json");
    expect(code).toContain("python3 scripts/plugin-baseline.py /tmp/plugin > /tmp/baseline.json");
    expect(code).toContain("git -C /tmp/plugin rev-parse HEAD");
  });
});
