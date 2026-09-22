/*
 * What an agent's own edits touched that a reviewer should read first.
 *
 * The rules are matched on the path and on the lines the edit added, never on a
 * model's opinion: the same edit must raise the same flag every time, and a
 * reason has to be one short sentence a person can check against the diff.
 *
 * Secrets in these fixtures are assembled from pieces, so that no scanner
 * pointed at this repository mistakes a test for a leak.
 */
import { describe, expect, test } from "bun:test";
import { changeRisks, sessionRisks, type RiskFlag } from "../../shared/riskFlags.ts";
import type { DiffHunk } from "../../shared/types.ts";

const added = (...lines: string[]): DiffHunk[] =>
  [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => "+" + l) }];
const removed = (n: number): DiffHunk[] =>
  [{ oldStart: 1, oldLines: n, newStart: 1, newLines: 0, lines: Array.from({ length: n }, (_, i) => `-line ${i}`) }];
const kinds = (f: RiskFlag[]) => f.map((x) => x.kind).sort();

const AWS = "AKIA" + "Q3EXAMPLEKEY7ZZX";
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";

describe("secrets", () => {
  test("a cloud access key added to a config file is flagged, with the line it landed on", () => {
    const f = changeRisks("/w/orbit/config/settings.yml", [
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" region: eu-west-1", `+access_key: ${AWS}`] },
    ], 0);
    expect(kinds(f)).toEqual(["secret"]);
    expect(f[0].line).toBe(11);
    expect(f[0].reason).toContain("access key");
  });

  test("a token, a private key and a quoted password assignment are each caught", () => {
    expect(kinds(changeRisks("/w/a.ts", added(`const t = "${GH}";`), 0))).toEqual(["secret"]);
    expect(kinds(changeRisks("/w/a.txt", added(PEM), 0))).toEqual(["secret"]);
    expect(kinds(changeRisks("/w/a.py", added(`DB_PASSWORD = "hunter2-orbit-prod-9f3a"`), 0))).toEqual(["secret"]);
  });

  test("a secret that was REMOVED is not a new secret", () => {
    const f = changeRisks("/w/a.ts", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: [`-const t = "${GH}";`] }], 1);
    expect(f.filter((x) => x.kind === "secret")).toEqual([]);
  });

  test("placeholders and reads from the environment are not secrets", () => {
    expect(changeRisks("/w/a.ts", added(`const password = process.env.DB_PASSWORD;`), 0)).toEqual([]);
    expect(changeRisks("/w/a.py", added(`api_key = "<your-api-key-here>"`), 0)).toEqual([]);
    expect(changeRisks("/w/a.py", added(`token = ""`), 0)).toEqual([]);
  });

  test("writing a dotenv file is flagged even when its values look harmless; its example is not", () => {
    expect(kinds(changeRisks("/w/orbit/.env", added("PORT=3000"), 0))).toEqual(["secret"]);
    expect(kinds(changeRisks("/w/orbit/.env.production", added("PORT=3000"), 0))).toEqual(["secret"]);
    expect(changeRisks("/w/orbit/.env.example", added("PORT=3000"), 0)).toEqual([]);
  });

  test("the same key twice in one edit is one flag, not two", () => {
    expect(changeRisks("/w/a.env.sample", added(`a=${AWS}`, `b=${AWS}`), 0).length).toBe(1);
  });
});

describe("paths", () => {
  test("CI workflow definitions", () => {
    for (const p of ["/w/orbit/.github/workflows/ci.yml", "/w/orbit/.gitlab-ci.yml", "/w/orbit/.circleci/config.yml", "/w/orbit/Jenkinsfile"]) {
      expect(kinds(changeRisks(p, added("x"), 0))).toEqual(["ci"]);
    }
    expect(changeRisks("/w/orbit/.github/CODEOWNERS.md", added("x"), 0)).toEqual([]);
  });

  test("a lockfile is always flagged; a manifest only when a dependency line moved", () => {
    expect(kinds(changeRisks("/w/orbit/bun.lock", added("x"), 0))).toEqual(["deps"]);
    expect(kinds(changeRisks("/w/orbit/poetry.lock", added("x"), 0))).toEqual(["deps"]);
    expect(kinds(changeRisks("/w/orbit/package.json", added(`    "left-pad": "^1.3.0",`), 0))).toEqual(["deps"]);
    expect(kinds(changeRisks("/w/orbit/requirements.txt", added("requests==2.32.0"), 0))).toEqual(["deps"]);
    // Editing a script in package.json is not a dependency change.
    expect(changeRisks("/w/orbit/package.json", added(`    "test": "bun test",`), 0)).toEqual([]);
  });

  test("database migrations", () => {
    for (const p of ["/w/orbit/db/migrations/0042_widen_orders.py", "/w/orbit/alembic/versions/3f2a_add_thing.py", "/w/orbit/prisma/migrations/20260101_init/migration.sql"]) {
      expect(kinds(changeRisks(p, added("x"), 0))).toEqual(["migration"]);
    }
  });

  test("auth and permission code, by the words in the path, not substrings of other words", () => {
    for (const p of ["/w/orbit/src/auth.ts", "/w/orbit/src/authMiddleware.ts", "/w/orbit/app/permissions/roles.py", "/w/orbit/src/oauth_callback.go", "/w/orbit/infra/iam-policy.tf"]) {
      expect(kinds(changeRisks(p, added("x"), 0))).toEqual(["auth"]);
    }
    for (const p of ["/w/orbit/AUTHORS.md", "/w/orbit/src/author.ts", "/w/orbit/src/aclient.ts"]) {
      expect(changeRisks(p, added("x"), 0)).toEqual([]);
    }
  });
});

describe("deletions", () => {
  test("a large deletion is flagged with its size; a small one is not", () => {
    const big = changeRisks("/w/orbit/src/big.ts", removed(250), 250);
    expect(kinds(big)).toEqual(["deletion"]);
    expect(big[0].reason).toContain("250");
    expect(changeRisks("/w/orbit/src/big.ts", removed(20), 20)).toEqual([]);
  });
});

describe("per session", () => {
  test("one entry per kind and file, the first reason kept, the list capped", () => {
    const flags = sessionRisks([
      { file_path: "/w/orbit/src/auth.ts", risks: [{ kind: "auth", reason: "a" }] },
      { file_path: "/w/orbit/src/auth.ts", risks: [{ kind: "auth", reason: "b" }] },
      { file_path: "/w/orbit/.env", risks: [{ kind: "secret", reason: "c" }] },
      { file_path: "/w/orbit/x.ts" },
    ]);
    expect(flags).toEqual([
      { kind: "auth", reason: "a", file: "/w/orbit/src/auth.ts" },
      { kind: "secret", reason: "c", file: "/w/orbit/.env" },
    ]);
    const many = Array.from({ length: 50 }, (_, i) => ({ file_path: `/w/${i}.lock`, risks: [{ kind: "deps" as const, reason: "r" }] }));
    expect(sessionRisks(many).length).toBeLessThanOrEqual(20);
  });
});
