/*
 * A node id reaches `gh` as a string, and only a node id reaches it at all.
 *
 * Every comment mutation in prs.ts hands GitHub a node id through `gh api
 * graphql`. The field flag was `-F` — gh's TYPED field, which reads `@/path` as
 * "the contents of this local file" — and the id came from the request body
 * unchecked. So `nodeId: "@/home/someone/.config/agentglass/token"` made this
 * server read the file and post its contents to GitHub as the subject of a
 * mutation. Two fences now, and this file exercises both: the id is checked
 * against the alphabet GitHub's ids are made of, and what passes goes through
 * `-f`, the raw string flag.
 *
 * The fake `gh` is a script on PATH that records its argv, run in a CHILD bun
 * for the reason pr-diff-force.test.ts gives: `Bun.which` reads the PATH the
 * process started with, so a PATH set in this process would still find the
 * real gh — and the real gh would then be asked to hide a comment.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdOk } from "../src/prs.ts";

describe("what counts as a node id", () => {
  it("is the base64 and PREFIX_ forms GitHub actually issues", () => {
    for (const id of ["MDEyOklzc3VlQ29tbWVudDE=", "IC_kwDOABCDEF4AaBcD", "PRRC_kwDOABCDEF5AaBcD", "PRRT_kwDOABCDEF4AaBcD", "PR_kwDOABCDEF4AaBcD", "MDU6SXNzdWUx"]) {
      expect(nodeIdOk(id), id).toBe(true);
    }
  });

  it("is never a file reference, a flag, or prose", () => {
    for (const bad of ["@/etc/hostname", "@~/.config/agentglass/token", "-x", "--help", "", "abc", "a b c d", "x".repeat(201), 42, null, undefined, "id;rm -rf /", "id\n--jq"]) {
      expect(nodeIdOk(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

const TMP = mkdtempSync(join(tmpdir(), "agx-node-id-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const ARGV = join(TMP, "gh-argv");
const DRIVER = join(TMP, "driver.ts");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const DRIVER_SRC = `
const [repo] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const out = {};
out.good = await P.hideComment(repo, "IC_kwDOABCDEF4AaBcD", "outdated");
out.file = await P.hideComment(repo, "@/etc/hostname");
out.flag = await P.unhideComment(repo, "--jq");
out.edit = await P.editComment(repo, "IC_kwDOABCDEF4AaBcD", "@sam thanks, done");
console.log(JSON.stringify(out));
`;

const ran = await (async () => {
  await Bun.$`mkdir -p ${BIN} ${REPO}`.quiet();
  writeFileSync(join(BIN, "gh"), [
    "#!/usr/bin/env bash",
    /* One line per call, argv NUL-joined so a field holding a space survives. */
    `printf '%s\\0' "$@" >> ${JSON.stringify(ARGV)}; printf '\\n' >> ${JSON.stringify(ARGV)}`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(BIN, "gh"), 0o755);
  writeFileSync(DRIVER, DRIVER_SRC);
  await Bun.$`git init -q ${REPO}`.quiet();
  await Bun.$`git -C ${REPO} remote add origin https://github.com/acme/demo.git`.quiet();
  const proc = Bun.spawn(["bun", "run", DRIVER, REPO], {
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, AGENTGLASS_ROOT: TMP, AGENTGLASS_CACHE_DIR: join(TMP, "cache"), XDG_CONFIG_HOME: join(TMP, "xdg"), AGENTGLASS_STATE_DIR: join(TMP, "state") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() || "";
  let out: Record<string, { ok: boolean; error?: string }>;
  try { out = JSON.parse(line); } catch { throw new Error(`driver said: ${stdout}${stderr}`); }
  const calls = existsSync(ARGV)
    ? readFileSync(ARGV, "utf8").split("\n").filter(Boolean).map((l) => l.split("\0").filter((x, i, a) => i < a.length - 1))
    : [];
  return { out, calls };
})();

describe("what gh is handed", () => {
  it("a real id goes through as a raw string, never as a typed field", () => {
    expect(ran.out.good!.ok).toBe(true);
    const hide = ran.calls.find((c) => c.some((a) => a.startsWith("query=") && a.includes("minimizeComment") && !a.includes("unminimize")));
    expect(hide, "hideComment never reached gh").toBeDefined();
    const i = hide!.indexOf("id=IC_kwDOABCDEF4AaBcD");
    expect(i).toBeGreaterThan(0);
    expect(hide![i - 1]).toBe("-f");
    expect(hide!.some((a, k) => a === "-F" && hide![k + 1]?.startsWith("id="))).toBe(false);
  });

  it("a file reference and a flag are refused before gh is spawned", () => {
    expect(ran.out.file!.ok).toBe(false);
    expect(ran.out.file!.error).toContain("invalid");
    expect(ran.out.flag!.ok).toBe(false);
    for (const c of ran.calls) {
      expect(c.join(" ")).not.toContain("@/etc/hostname");
      expect(c.join(" ")).not.toContain("id=--jq");
    }
  });

  it("a comment body beginning with a mention is a body, not a file to read", () => {
    /* Under `-F`, "@sam thanks" made gh open a file called "sam thanks". */
    expect(ran.out.edit!.ok).toBe(true);
    const edit = ran.calls.find((c) => c.some((a) => a.includes("updateIssueComment")));
    expect(edit).toBeDefined();
    const i = edit!.indexOf("b=@sam thanks, done");
    expect(i).toBeGreaterThan(0);
    expect(edit![i - 1]).toBe("-f");
  });
});
