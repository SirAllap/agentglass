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

describe("what a first review found flagged that should not be", () => {
  test("an identifier that only STARTS with a secret word, or a value that is a name, is not a secret", () => {
    for (const l of [
      `passwordLabel: "Password",`,
      `"auth.password.label": "Password",`,
      `const passwordInputId = "password-input";`,
      `const apiKeyHeader = "X-Api-Key";`,
      `SECRET_KEY_ENV = "DJANGO_SECRET_KEY"`,
      `private_key_path = "/etc/ssl/private/orbit.pem"`,
      `const accessTokenCookie = "orbit_access_token";`,
      `API_KEY_ENV = "ORBIT_API_KEY"`,
    ]) expect(changeRisks("/w/orbit/src/form.ts", added(l), 0)).toEqual([]);
  });

  test("the checkout's own folder name is not part of what the path says", () => {
    const opts = { root: "/home/dev/code/orbit-sso-login" };
    expect(changeRisks("/home/dev/code/orbit-sso-login/src/format.ts", added("x"), 0, opts)).toEqual([]);
    expect(changeRisks("/home/dev/code/data-migrations-kit/src/util.ts", added("x"), 0, { root: "/home/dev/code/data-migrations-kit" })).toEqual([]);
    // Inside the checkout the words still count.
    expect(kinds(changeRisks("/home/dev/code/orbit-sso-login/src/auth/session.ts", added("x"), 0, opts))).toEqual(["auth"]);
  });

  test("policy, login and password are ordinary words; migrate counts as a folder, not a file", () => {
    for (const p of ["/w/orbit/src/retryPolicy.ts", "/w/orbit/web/src/pages/PrivacyPolicy.tsx", "/w/orbit/src/LoginPage.tsx", "/w/orbit/src/PasswordInput.tsx", "/w/orbit/scripts/migrate-users.ts"]) {
      expect(changeRisks(p, added("x"), 0)).toEqual([]);
    }
    expect(kinds(changeRisks("/w/orbit/db/migrate/20260101_add_orders.rb", added("x"), 0))).toEqual(["migration"]);
    expect(kinds(changeRisks("/w/orbit/src/OAuth2Client.ts", added("x"), 0))).toEqual(["auth"]);
  });

  test("an engines pin and a script that runs git are not dependencies; a public certificate is not a key", () => {
    expect(changeRisks("/w/orbit/package.json", added(`    "node": ">=18"`), 0)).toEqual([]);
    expect(changeRisks("/w/orbit/package.json", added(`    "prepare": "git config core.hooksPath .githooks"`), 0)).toEqual([]);
    expect(kinds(changeRisks("/w/orbit/package.json", added(`    "orbit-ui": "git+https://example.com/orbit-ui.git"`), 0))).toEqual(["deps"]);
    expect(changeRisks("/w/orbit/certs/ca-bundle.pem", added("x"), 0)).toEqual([]);
    expect(kinds(changeRisks("/w/orbit/certs/server-key.pem", added("x"), 0))).toEqual(["secret"]);
  });

  test("a line number is only given when the hunk knows where it is in the file", () => {
    const h: DiffHunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" a", "\\ No newline at end of file", `+k = "${GH}"`] }];
    expect(changeRisks("/w/a.ts", h, 0)[0].line).toBe(2);
    expect(changeRisks("/w/a.ts", h, 0, { lines: false })[0].line).toBeUndefined();
  });

  test("the session roll-up keeps the line and the change it came from", () => {
    expect(sessionRisks([{ id: 7, file_path: "/w/a.yml", risks: [{ kind: "secret", reason: "r", line: 3 }] }]))
      .toEqual([{ kind: "secret", reason: "r", line: 3, file: "/w/a.yml", change: 7 }]);
  });
});

describe("what a second review found", () => {
  // Assembled from pieces like the others, and each one plainly invented.
  const HEX = "9f8e7d6c" + "5b4a32109f8e";
  const ALNUM = "orbit4Harbor" + "7Lantern";
  const SLASHED = "orbit/7Lantern" + "/Harbor42+q";

  test("a credential made only of letters and digits is caught, and so is one with a slash inside", () => {
    // The rule that skips an environment variable's NAME was case-insensitive,
    // so it skipped every letters-and-digits value as well; and any slash was
    // read as a path. Only a value with punctuation was ever flagged.
    for (const l of [
      `API_KEY = "${HEX}"`,
      `DB_PASSWORD = "${ALNUM}"`,
      `secret: "${ALNUM}"`,
      `aws_secret_access_key = "${SLASHED}"`,
    ]) expect(kinds(changeRisks("/w/orbit/src/config.py", added(l), 0))).toEqual(["secret"]);
  });

  test("a name, a path and a URL assigned to a secret word are still not secrets", () => {
    for (const l of [
      `API_KEY = "ORBIT_API_KEY2"`,
      `private_key = "./certs/orbit2.pem"`,
      `private_key = "/etc/orbit/tls2.key"`,
      `secret: "https://vault.orbit.dev/v1/kv"`,
    ]) expect(changeRisks("/w/orbit/src/config.py", added(l), 0)).toEqual([]);
  });


  test("a package.json description or licence that starts with a digit is not a dependency", () => {
    expect(changeRisks("/w/orbit/package.json", added(`  "description": "2 ways to ship orbit",`), 0)).toEqual([]);
    expect(changeRisks("/w/orbit/package.json", added(`  "license": "0BSD",`), 0)).toEqual([]);
    expect(kinds(changeRisks("/w/orbit/package.json", added(`    "orbit-core": "2.1.0",`), 0))).toEqual(["deps"]);
  });


  test("a long kebab-case class name is not an API key; an sk- key still is", () => {
    expect(changeRisks("/w/orbit/src/app.css", added(`.sk-loading-spinner-container-wrapper-x { }`), 0)).toEqual([]);
    const SK = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    expect(kinds(changeRisks("/w/orbit/src/client.ts", added(`const k = "${SK}";`), 0))).toEqual(["secret"]);
    const SK_PROJ = "sk-proj-" + "a1B2c3D4e5F6-g7H8i9J0k1L2m3N4o5P6q7R8";
    expect(kinds(changeRisks("/w/orbit/src/client.ts", added(`const k = "${SK_PROJ}";`), 0))).toEqual(["secret"]);
  });
});
