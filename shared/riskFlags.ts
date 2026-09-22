/**
 * What an agent's edit touched that a reviewer should read first.
 *
 * The gate looks at a tool call before it runs; this is the other side, the
 * edit after it landed. Every rule is a match on the file's path or on the
 * lines the edit ADDED — never a model call — so the same edit raises the same
 * flag every time and the reason is one sentence a person can check against
 * the diff. A removed line is only counted for size and for a dependency line
 * disappearing: deleting a key from a file is the fix, not the leak.
 *
 * One copy, in `shared/`: the server attaches the flags to each change and
 * rolls them up per session, and nothing on the web side re-derives them.
 *
 * What it cannot see, said so the next person can tell a chosen limit from a
 * gap: only Edit/Write/MultiEdit are changes here, so a lockfile rewritten by
 * `bun add` in a shell, or a file removed with `rm`, raises nothing; a secret
 * shape not in SECRET_SHAPES is missed; and a manifest other than package.json
 * is flagged on any edit, because telling a dependency line from any other
 * line is only done for the one format whose dependency lines have a shape.
 */
import type { DiffHunk, RiskFlag, RiskKind, SessionRisk } from "./types.ts";

export type { RiskFlag, RiskKind, SessionRisk };

/** Shapes with a fixed prefix — the ones a provider documents, so a match is
 *  almost never anything else. */
const SECRET_SHAPES: [RegExp, string][] = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b[sr]k_live_[A-Za-z0-9]{16,}/, "a Stripe live key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, "an API key"],
];

/**
 * A quoted literal assigned to something whose name ENDS in a secret word:
 * `DB_PASSWORD = "…"`, `"api_key": "…"`, `aws_secret_access_key = "…"`.
 * Ending, because an identifier that only starts with one is almost always
 * about the secret rather than holding it — `passwordLabel`, `apiKeyHeader`,
 * `SECRET_KEY_ENV`, `private_key_path` were each a red chip on an ordinary
 * form or settings edit before this.
 * Nothing is matched before the word: whatever prefixes it (`DB_`) is allowed
 * anyway, and a pattern for the prefix is what made a 4000-character snake_case
 * line cost 180 ms.
 */
const ASSIGNED = /(?:password|passwd|secret|(?:api|secret|access)[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
/** Values that are a hole to fill in, not a secret. */
const PLACEHOLDER = /[<>{}$]|example|changeme|your|xxxx|dummy|placeholder|redacted|\*\*\*/i;
/** Values that are a name rather than a secret: an environment variable's
 *  (`ORBIT_API_KEY`), a path, a URL, a header, an ARN. And a real credential
 *  mixes letters with digits; a word on its own is a label.
 *
 *  The variable name is matched case-SENSITIVELY and needs an underscore: with
 *  `/i` the shape was every letters-and-digits value, which is most real keys
 *  and passwords, and not one of them was flagged. A path is one that STARTS
 *  like a path: a slash anywhere also skipped base64, whose alphabet has one. */
const NAME_NOT_SECRET = [
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^(?:\.{0,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/|x-|arn:)/i,
];
const MIXED = /[A-Za-z].*\d|\d.*[A-Za-z]/;
/** Past this a line is generated (a bundle, a lockfile's integrity blob), and
 *  the assignment rule is the one that could backtrack on it. */
const LONG_LINE = 4000;

const DOTENV = /^\.env(?:\..+)?$/;
const DOTENV_EXAMPLE = /\.(?:example|sample|template|dist|defaults?)$/;
/** A `.pem` is as often a public certificate as a key, so only one named as a
 *  key counts; a PEM private key in the content is caught by SECRET_SHAPES. */
const KEY_FILE = /\.(?:p12|pfx|key)$|^id_(?:rsa|dsa|ecdsa|ed25519)$|(?:key|private)[^/]*\.pem$/i;

const CI_NAMES = new Set([".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml"]);
const CI_DIRS = ["/.github/workflows/", "/.github/actions/", "/.circleci/", "/.buildkite/"];

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "go.sum", "Gemfile.lock", "composer.lock",
  "flake.lock", "packages.lock.json", "gradle.lockfile",
]);
const MANIFESTS = new Set([
  "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json", "Pipfile",
  "build.gradle", "build.gradle.kts", "pom.xml",
]);
/** A package.json line naming a package and a version — `"left-pad": "^1.3.0"`.
 *  A script (`"test": "bun test"`, `"prepare": "git config …"`) starts its
 *  value with a word and does not match; the package's own `version`, the
 *  free-text fields that can start with a digit (`"description": "2 ways…"`,
 *  `"license": "0BSD"`) and the `engines` pins are excluded by name. No bare
 *  URL form: `homepage` and `repository` hold those too. */
const PKG_DEP_LINE = /^\s*"(?!(?:version|description|license|name|author|node|npm|bun|yarn|pnpm)")[@\w./-]+"\s*:\s*"(?:[\^~<>=*]|\d|workspace:|npm:|file:|link:|git\+|git:|github:|latest")/;

const AUTH_WORDS = new Set([
  "auth", "authn", "authz", "authentication", "authorization", "authorize", "oauth", "oauth2",
  "permission", "permissions", "rbac", "acl", "acls", "iam",
  "jwt", "sso", "saml", "sudoers", "credential", "credentials",
]);
// Left out on purpose, each measured as noise: `policy` (retryPolicy,
// PrivacyPolicy), `login` and `password` (LoginPage, PasswordInput — a form,
// not the code that decides who gets in).
/** Prose about auth is not auth code. */
const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc)$/i;

/** Deleted lines in one edit past which the edit is flagged for its size. */
export const LARGE_DELETION = 200;
/** Per session, so a card's tooltip stays a list rather than a wall. */
export const SESSION_RISK_CAP = 20;

/** The words a path is made of: its segments, split on separators and on
 *  camelCase, lowercased. `authMiddleware.ts` is `auth` + `middleware`, and
 *  `AUTHORS.md` is `authors` — never `auth`. */
function pathWords(path: string): string[] {
  return path
    .split(/[\/\\_.\-\s]+/)
    .flatMap((s) => s.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((w) => w.toLowerCase().replace(/\d+$/, ""))
    .filter(Boolean);
}

function secretIn(line: string): string | null {
  for (const [re, what] of SECRET_SHAPES) if (re.test(line)) return what;
  if (line.length > LONG_LINE) return null;
  const m = ASSIGNED.exec(line);
  const v = m?.[1];
  if (v && !PLACEHOLDER.test(v) && !NAME_NOT_SECRET.some((re) => re.test(v)) && MIXED.test(v)) return "a hard-coded credential";
  return null;
}

/**
 * The flags one edit raises: at most one per kind, the first match kept.
 *
 * `deletions` is passed rather than recounted because the caller already
 * counted it from the same hunks. `root` is the directory the agent ran in:
 * the path rules read only what is below it, so a checkout named after its
 * branch (`orbit-sso-login`) does not flag every file in it. An agent started
 * in a subdirectory loses that directory's own name the same way — the price
 * of not asking git for the top level on every edit. `lines: false` says the
 * hunks were rebuilt from an edit's strings and start at 1 rather than where
 * they sit in the file, so no line number is given.
 */
export function changeRisks(
  filePath: string, hunks: DiffHunk[], deletions: number,
  opts: { root?: string | null; lines?: boolean } = {},
): RiskFlag[] {
  const out: RiskFlag[] = [];
  const p = filePath.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  const root = opts.root?.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = root && p.startsWith(root + "/") ? p.slice(root.length) : p;

  // Secrets: a line that carries one beats a file whose name says it might.
  let secret: RiskFlag | null = null;
  let depLine = false;
  const isPkg = base === "package.json";
  for (const h of hunks) {
    let ln = h.newStart;
    for (const l of h.lines ?? []) {
      const sign = l[0];
      // "\ No newline at end of file" is a note about the line before it, not
      // a line of the file.
      if (sign === "\\") continue;
      if (sign === "-") {
        if (isPkg && PKG_DEP_LINE.test(l.slice(1))) depLine = true;
        continue;
      }
      if (sign === "+") {
        if (!secret) {
          const what = secretIn(l);
          if (what) secret = { kind: "secret", reason: `${what} was added`, ...(opts.lines === false ? {} : { line: ln }) };
        }
        if (isPkg && !depLine && PKG_DEP_LINE.test(l.slice(1))) depLine = true;
      }
      ln++;
    }
  }
  if (!secret && DOTENV.test(base) && !DOTENV_EXAMPLE.test(base)) secret = { kind: "secret", reason: "a dotenv file was written — it usually holds live credentials" };
  if (!secret && KEY_FILE.test(base)) secret = { kind: "secret", reason: "a key file was written" };
  if (secret) out.push(secret);

  if (CI_NAMES.has(base) || CI_DIRS.some((d) => rel.includes(d))) {
    out.push({ kind: "ci", reason: "a CI definition changed — it runs with the repository's secrets" });
  }

  if (LOCKFILES.has(base)) out.push({ kind: "deps", reason: "a lockfile changed — resolved dependency versions moved" });
  else if (MANIFESTS.has(base) || /^requirements.*\.txt$/.test(base)) out.push({ kind: "deps", reason: "a dependency manifest changed" });
  else if (depLine) out.push({ kind: "deps", reason: "a dependency was added, removed or re-versioned" });

  // Folders, not words: `db/migrate/` is Rails' migrations; a script called
  // `migrate-users.ts` is not a migration.
  const dirs = rel.split("/").slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.includes("migrations") || dirs.includes("migrate") || (dirs.includes("alembic") && dirs.includes("versions"))) {
    out.push({ kind: "migration", reason: "a database migration changed" });
  }

  if (!DOC_EXT.test(base)) {
    const hit = pathWords(rel).find((w) => AUTH_WORDS.has(w));
    if (hit) out.push({ kind: "auth", reason: `auth or permission code changed (${hit})` });
  }

  if (deletions >= LARGE_DELETION) out.push({ kind: "deletion", reason: `a large deletion: −${deletions} lines` });

  return out;
}

/**
 * One session's flags, for its card: one entry per kind and file, in the order
 * the changes arrive (the caller passes newest first, so the newest reason is
 * the one kept), capped at SESSION_RISK_CAP.
 */
export function sessionRisks(changes: { id?: number; file_path: string; risks?: RiskFlag[] }[]): SessionRisk[] {
  const out: SessionRisk[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    for (const r of c.risks ?? []) {
      const k = `${r.kind}\0${c.file_path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: r.kind, reason: r.reason, ...(r.line ? { line: r.line } : {}), file: c.file_path, ...(c.id != null ? { change: c.id } : {}) });
      if (out.length >= SESSION_RISK_CAP) return out;
    }
  }
  return out;
}
