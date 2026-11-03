/*
 * Preflight: the parser, and the invocation against a stub claude that writes
 * down how it was started. The invocation is the product here: a reviewer with
 * no context is only that if it runs in a directory holding nothing else, with
 * the flags that keep the machine's memory and hooks out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LIMIT_BYTES, ISOLATION, parseFindings, runPreflight, type PreflightInput } from "../src/preflight.ts";

const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
const REPO = new URL("../..", import.meta.url).pathname;
let dir: string;
const rec = () => join(dir, "record.json");
const record = () => JSON.parse(readFileSync(rec(), "utf8")) as { argv: string[]; cwd: string; tree: { path: string; mode: number }[]; contents: Record<string, string>; env: Record<string, string | null> };
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const run = (input: Partial<PreflightInput>, reply = "No findings", extra: Record<string, string> = {}) =>
  runPreflight({ files: [], model: "sonnet", budgetUsd: 0.5, ...input }, { bin: [process.execPath, STUB], env: { STUB_RECORD: rec(), STUB_REPLY: reply, ...extra } });

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-pftest-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseFindings", () => {
  test("headings, severities, quote and evidence, several findings", () => {
    const f = parseFindings("### F1 - Blocker - No way to check it\nQuote: it works\nEvidence: nothing runs it\nsecond line\n\n### F2 - nit - Name\nQuote: x\nEvidence: y\n")!;
    expect(f.map((x) => [x.id, x.severity, x.title])).toEqual([["F1", "blocker", "No way to check it"], ["F2", "nit", "Name"]]);
    expect(f[0]).toMatchObject({ quote: "it works", evidence: "nothing runs it\nsecond line", action: null, note: null });
  });
  test("No findings is an empty list", () => {
    expect(parseFindings("No findings")).toEqual([]);
    expect(parseFindings("  No findings.\n")).toEqual([]);
  });
  test("anything else is a failure, not an empty review", () => {
    expect(parseFindings("Looks great to me!")).toBeNull();
    expect(parseFindings("")).toBeNull();
    expect(parseFindings("### F1 - Huge - bad severity\nQuote: a")).toBeNull();
  });
});

describe("the invocation", () => {
  test("argv, cwd, env, and a directory that holds only what was named", async () => {
    const root = join(dir, "proj"); mkdirSync(join(root, "src"), { recursive: true });
    const plan = join(root, "PLAN.md"), code = join(root, "src", "a.ts");
    writeFileSync(plan, "# Plan\nDo the thing.\n"); writeFileSync(code, "export const a = 1;\n");
    writeFileSync(join(root, "SECRET.md"), "not listed");
    const cert = await run({ files: [plan, code], root, id: "pf_x" }, "### F1 - Major - Unstated\nQuote: Do the thing.\nEvidence: src/a.ts:1");
    const r = record();
    const prompt = r.argv[r.argv.length - 1]!;
    expect(r.argv.slice(0, -1)).toEqual(["-p", "--setting-sources", "project", "--model", "sonnet", "--output-format", "json", "--max-budget-usd", "0.5", "--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob", "--"]);
    expect(prompt).toContain("MATERIAL.md");
    expect(prompt).not.toContain("mockup/");
    expect(r.cwd.startsWith(tmpdir())).toBe(true);
    expect(r.cwd.startsWith(REPO)).toBe(false);
    expect(r.tree.map((f) => f.path)).toEqual(["MATERIAL.md", "files/PLAN.md", "files/src/a.ts"]);
    expect(r.tree.every((f) => f.mode === 0o444)).toBe(true);
    expect(r.env.memoryOff).toBe("1");
    expect(r.env.claudecode).toBeNull();
    expect(existsSync(r.cwd)).toBe(false);
    expect(cert).toMatchObject({
      id: "pf_x", model: "sonnet", costUsd: 0.0123, sawConversation: false, isolation: ISOLATION, skipped: [], mockups: [],
      files: [{ path: plan, sha256: sha("# Plan\nDo the thing.\n"), bytes: 21 }, { path: code, sha256: sha("export const a = 1;\n"), bytes: 20 }],
      findings: [{ id: "F1", severity: "major", title: "Unstated", quote: "Do the thing.", evidence: "src/a.ts:1", action: null, note: null }],
    });
  });

  test("a parent session's variables are dropped, the caller's are added last", async () => {
    process.env.CLAUDECODE = "1"; process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    try {
      const f = join(dir, "e.md"); writeFileSync(f, "x");
      await run({ files: [f] }, "No findings", { STUB_EXTRA: "from-deps" });
    } finally { delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT; }
    expect(record().env).toMatchObject({ claudecode: null, entrypoint: null, memoryOff: "1", extra: "from-deps" });
  });

  test("the child gets an allowlisted environment: a planted secret is absent, ANTHROPIC_* and PATH stay", async () => {
    process.env.SECRET_X = "hunter2"; process.env.ANTHROPIC_API_KEY = "k";
    try {
      const f = join(dir, "s.md"); writeFileSync(f, "x");
      await run({ files: [f] });
    } finally { delete process.env.SECRET_X; delete process.env.ANTHROPIC_API_KEY; }
    expect(record().env).toMatchObject({ secret: null, anthropic: "k", memoryOff: "1" });
    expect(record().env.path).toBeTruthy();
  });

  test("a symlink among the files is skipped, and a reserved or pathy extra-text name is refused", async () => {
    const real = join(dir, "real.md"); writeFileSync(real, "x");
    const link = join(dir, "link.md"); symlinkSync(real, link);
    const cert = await run({ files: [real, link] });
    expect(cert.files.map((f) => f.path)).toEqual([real]);
    expect(cert.skipped).toEqual([{ path: link, reason: "not a regular file" }]);
    for (const name of ["MATERIAL.md", "PR.md", "PR.diff", "../x.md", "a/b.md"]) {
      await expect(run({ files: [], extraText: [{ name, body: "x" }] }), name).rejects.toThrow(/not allowed/);
    }
  });

  test("a file over the limit, a directory and a missing path are skipped with a reason", async () => {
    const big = join(dir, "big.bin"); writeFileSync(big, Buffer.alloc(FILE_LIMIT_BYTES + 1));
    const ok = join(dir, "ok.md"); writeFileSync(ok, "ok");
    const cert = await run({ files: [ok, big, dir, join(dir, "gone")] });
    expect(cert.files.map((f) => f.path)).toEqual([ok]);
    expect(cert.skipped.map((s) => s.path)).toEqual([big, dir, join(dir, "gone")]);
    expect(cert.skipped[0]!.reason).toContain("5 MB");
    expect(record().tree.map((f) => f.path)).toEqual(["MATERIAL.md", `files${ok}`]);
  });

  test("mockups sit under mockup/, are listed with a hash, and the prompt reads them", async () => {
    const plan = join(dir, "p.md"); writeFileSync(plan, "plan");
    const png = join(dir, "screen.png"), html = join(dir, "page.html"), exe = join(dir, "run.sh");
    writeFileSync(png, Buffer.from([137, 80, 78, 71])); writeFileSync(html, "<p>x</p>"); writeFileSync(exe, "echo");
    const cert = await run({ files: [plan], mockups: [png, html, exe] });
    const r = record();
    expect(r.tree.map((f) => f.path)).toEqual(expect.arrayContaining(["mockup/page.html", "mockup/screen.png"]));
    expect(r.tree.some((f) => f.path === "mockup/run.sh")).toBe(false);
    expect(r.argv[r.argv.length - 1]).toContain("mockup/");
    expect(cert.mockups).toEqual([
      { path: png, sha256: sha(Buffer.from([137, 80, 78, 71])), bytes: 4, kind: "image" },
      { path: html, sha256: sha("<p>x</p>"), bytes: 8, kind: "html" },
    ]);
    expect(cert.skipped).toEqual([{ path: exe, reason: expect.stringContaining("mockup") }]);
  });

  test("a pull request is read through the gh seam and becomes PR.md and PR.diff", async () => {
    const calls: string[][] = [];
    const cert = await runPreflight({ files: [], pr: { number: 7, root: dir }, model: "sonnet", budgetUsd: 1 }, {
      bin: [process.execPath, STUB], env: { STUB_RECORD: rec() },
      gh: async (a, cwd) => { calls.push([...a, cwd]); return a[1] === "view" ? JSON.stringify({ title: "Add thing", body: "Does it." }) : "diff --git a b\n"; },
    });
    expect(calls).toEqual([["pr", "view", "7", "--json", "title,body", dir], ["pr", "diff", "7", dir]]);
    const r = record();
    expect(r.contents["PR.md"]).toBe("# Add thing\n\nDoes it.\n");
    expect(r.contents["PR.diff"]).toBe("diff --git a b\n");
    expect(r.argv[r.argv.length - 1]).toContain("PR.md and PR.diff");
    expect(cert.findings).toEqual([]);
  });

  test("extra text is the material when there is no pull request", async () => {
    await run({ files: [], extraText: [{ name: "TASK.md", body: "# Task\nDone." }] });
    const r = record();
    expect(r.contents["TASK.md"]).toBe("# Task\nDone.");
    expect(r.argv[r.argv.length - 1]).toContain("TASK.md is what is being reviewed");
  });

  test("a reply that is not findings fails with the head of it, and the directory is still removed", async () => {
    const f = join(dir, "g.md"); writeFileSync(f, "x");
    await expect(run({ files: [f] }, "I think this is fine.")).rejects.toThrow(/no findings and no "No findings": I think this is fine/);
    expect(existsSync(record().cwd)).toBe(false);
  });

  test("a run the budget stopped says so, with what it spent", async () => {
    const json = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5213 });
    await expect(run({ extraText: [{ name: "T.md", body: "x" }] }, "", { STUB_JSON: json })).rejects.toThrow("stopped at the cap: spent $0.52 of $0.50");
    // The error carries what the run spent, so the budget counts it.
    await expect(run({ extraText: [{ name: "T.md", body: "x" }] }, "", { STUB_JSON: json })).rejects.toMatchObject({ costUsd: 0.5213 });
  });

  test("a reviewer that gave no reply to read is billed at its cap", async () => {
    await expect(run({ extraText: [{ name: "T.md", body: "x" }] }, "", { STUB_JSON: "not json" })).rejects.toMatchObject({ costUsd: 0.5 });
  });

  test("a child that is not claude at all fails, not hangs", async () => {
    await expect(runPreflight({ files: [], extraText: [{ name: "T.md", body: "x" }], model: "sonnet", budgetUsd: 1 }, { bin: ["/bin/false"] })).rejects.toThrow(/no JSON/);
  });
});
