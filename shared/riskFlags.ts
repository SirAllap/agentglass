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

/** A quoted literal assigned to something named like a secret. No leading
 *  `[\w.-]*`: that would rescan every start position of a long identifier run,
 *  and a minified line is one long run. */
const ASSIGNED = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
/** Values that are a hole to fill in, not a secret. */
const PLACEHOLDER = /[<>{}$]|example|changeme|your|xxxx|dummy|placeholder|redacted|\*\*\*/i;
/** Past this a line is generated (a bundle, a lockfile's integrity blob), and
 *  the assignment rule is the one that could backtrack on it. */
const LONG_LINE = 4000;

const DOTENV = /^\.env(?:\..+)?$/;
const DOTENV_EXAMPLE = /\.(?:example|sample|template|dist|defaults?)$/;
const KEY_FILE = /\.(?:pem|p12|pfx|key)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/;

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
 *  A script (`"test": "bun test"`) starts its value with a letter and does not
 *  match; `"version"` is the package's own and is excluded by name. */
const PKG_DEP_LINE = /^\s*"(?!version")[@\w./-]+"\s*:\s*"(?:[\^~<>=*]|\d|workspace:|npm:|file:|link:|git|https?:|github:|latest")/;

const AUTH_WORDS = new Set([
  "auth", "authn", "authz", "authentication", "authorization", "authorize", "oauth", "oauth2",
  "permission", "permissions", "rbac", "acl", "acls", "iam", "policy", "policies",
  "login", "jwt", "sso", "saml", "sudoers", "credential", "credentials", "password", "passwords",
]);
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
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function secretIn(line: string): string | null {
  for (const [re, what] of SECRET_SHAPES) if (re.test(line)) return what;
  if (line.length > LONG_LINE) return null;
  const m = ASSIGNED.exec(line);
  if (m && !PLACEHOLDER.test(m[1]!)) return "a hard-coded credential";
  return null;
}

/**
 * The flags one edit raises: at most one per kind, the first match kept.
 *
 * `deletions` is passed rather than recounted because the caller already
 * counted it from the same hunks.
 */
export function changeRisks(filePath: string, hunks: DiffHunk[], deletions: number): RiskFlag[] {
  const out: RiskFlag[] = [];
  const p = filePath.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);

  // Secrets: a line that carries one beats a file whose name says it might.
  let secret: RiskFlag | null = null;
  let depLine = false;
  const isPkg = base === "package.json";
  for (const h of hunks) {
    let ln = h.newStart;
    for (const l of h.lines ?? []) {
      const sign = l[0];
      if (sign === "-") {
        if (isPkg && PKG_DEP_LINE.test(l.slice(1))) depLine = true;
        continue;
      }
      if (sign === "+") {
        if (!secret) {
          const what = secretIn(l);
          if (what) secret = { kind: "secret", reason: `${what} was added`, line: ln };
        }
        if (isPkg && !depLine && PKG_DEP_LINE.test(l.slice(1))) depLine = true;
      }
      ln++;
    }
  }
  if (!secret && DOTENV.test(base) && !DOTENV_EXAMPLE.test(base)) secret = { kind: "secret", reason: "a dotenv file was written — it usually holds live credentials" };
  if (!secret && KEY_FILE.test(base)) secret = { kind: "secret", reason: "a key file was written" };
  if (secret) out.push(secret);

  if (CI_NAMES.has(base) || CI_DIRS.some((d) => p.includes(d))) {
    out.push({ kind: "ci", reason: "a CI definition changed — it runs with the repository's secrets" });
  }

  if (LOCKFILES.has(base)) out.push({ kind: "deps", reason: "a lockfile changed — resolved dependency versions moved" });
  else if (MANIFESTS.has(base) || /^requirements.*\.txt$/.test(base)) out.push({ kind: "deps", reason: "a dependency manifest changed" });
  else if (depLine) out.push({ kind: "deps", reason: "a dependency was added, removed or re-versioned" });

  const words = pathWords(p);
  if (words.includes("migrations") || words.includes("migrate") || (words.includes("alembic") && words.includes("versions"))) {
    out.push({ kind: "migration", reason: "a database migration changed" });
  }

  if (!DOC_EXT.test(base)) {
    const hit = words.find((w) => AUTH_WORDS.has(w));
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
export function sessionRisks(changes: { file_path: string; risks?: RiskFlag[] }[]): SessionRisk[] {
  const out: SessionRisk[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    for (const r of c.risks ?? []) {
      const k = `${r.kind}\0${c.file_path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: r.kind, reason: r.reason, file: c.file_path });
      if (out.length >= SESSION_RISK_CAP) return out;
    }
  }
  return out;
}
