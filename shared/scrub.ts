// A privacy-preserving diagnostic scrubber — the core both reporting paths
// depend on (#207, prerequisite for #208).
//
// Unlike most apps, an agentglass error is SATURATED with user data. A bare
// stack trace or message routinely carries file paths (which leak the OS
// username and the names of private projects), the content that caused the
// error (a prompt, a file slice, a diff, command output), env values or tokens,
// and repo/session identifiers. So "send only the error, nothing about the
// user" is not a filter bolted on — it is the whole design.
//
// The design is an ALLOWLIST, not a blocklist: a report is assembled from things
// known to be safe, and everything else is dropped by default. When in doubt,
// drop it — a less useful report is always better than one that leaks. This
// module is pure and dependency-free so both the server and the web can build
// the exact same SafeReport, and so its guarantee can be proven by tests.

/** The ONLY shape either reporting path is allowed to send. */
export interface SafeReport {
  /** The error's constructor name, e.g. "TypeError". Inert. */
  errorType: string;
  /** The message, redacted: paths, secrets and home dirs removed. */
  message: string;
  /** Stack frames from agentglass's OWN code only, app-relative. A frame that
   *  resolves into a user repo, ~/.claude, node_modules or any path outside the
   *  app is dropped entirely. */
  frames: string[];
  /** Coarse subsystem the error came from (a panel/route name), never the data
   *  it was acting on. Omitted when absent. */
  category?: string;
  /** Build provenance — safe by construction. */
  app: { version?: string; commit?: string };
  /** Host coordinates, no identity. */
  runtime: { os?: string; arch?: string; bun?: string; electron?: string };
}

export interface Diagnostic {
  /** An Error, an error-like object, or a bare string. */
  error: unknown;
  category?: unknown;
  app?: { version?: unknown; commit?: unknown };
  runtime?: { os?: unknown; arch?: unknown; bun?: unknown; electron?: unknown };
}

const MAX_MSG = 500;
const MAX_FRAMES = 20;
const MAX_CATEGORY = 40;
const MAX_FIELD = 40;

// agentglass's own source roots. A path (in a message or a frame) is only ever
// kept as the tail from one of these; anything else is dropped.
const APP_MARKERS = ["/server/src/", "/web/src/", "/electron/", "/shared/", "/scripts/"];

// Secrets, redacted before anything else so a token buried in a path or URL is
// caught too. Deliberately broad — a false positive costs a bit of readability,
// a false negative leaks a credential.
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / refresh / server tokens
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT
  /(?:bearer|authorization|api[_-]?key|token|secret|password)\s*[:=]?\s*["']?[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b[A-Za-z0-9+]{40,}={0,2}\b/g, // long high-entropy blob (raw base64/hex secrets); no "/" so it never eats a path
];

/**
 * Redact credential-shaped text, leaving everything else alone.
 *
 * Exported separately from `redactText` because one caller needs exactly this
 * half: the AI walkthrough sends real diffs to a model, so paths have to
 * survive — a patch whose every path became `<path>` describes nothing — while
 * a key on a changed line must not.
 */
export function stripSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<redacted-secret>");
  return out;
}

/** The app-relative tail of a path that runs through an app marker, else null. */
function appRelative(p: string): string | null {
  const norm = p.replace(/\\/g, "/");
  let best: number | null = null;
  for (const m of APP_MARKERS) {
    const i = norm.indexOf(m);
    if (i !== -1 && (best === null || i < best)) best = i;
  }
  return best === null ? null : norm.slice(best + 1); // drop the marker's leading slash
}

// Absolute paths: unix (/…/…, at least two segments) not preceded by a word
// char, so a mid-word slash in prose ("read/write") is left alone; and windows
// (C:\…). Each is replaced with its app-relative tail if it runs through the
// app, otherwise dropped to <path>.
const PATH_RE = /(?<![\w.])(?:[A-Za-z]:\\[^\s"'`):]+|\/[^\s"'`):]+(?:\/[^\s"'`):]+)+\/?)/g;

function redactPaths(s: string): string {
  return s.replace(PATH_RE, (p) => appRelative(p) ?? "<path>");
}

/** Reduce free text to something safe to send: secrets gone, paths dropped
 *  unless they are the app's own. Exported for tests. */
export function redactText(s: string): string {
  if (typeof s !== "string" || !s) return "";
  // Paths first: a path that runs through the app is reduced to its safe tail,
  // any other absolute path (a user repo, ~/.claude, a home dir) is dropped
  // whole — taking any token buried inside it with it. Then secrets, for tokens
  // sitting in open text.
  return stripSecrets(redactPaths(s));
}

function scrubFrames(stack: string): string[] {
  const out: string[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue; // only real V8 frames
    const path = line.match(/(?:[A-Za-z]:\\[^\s"'`):]+|\/[^\s"'`):]+)/);
    if (!path) continue; // a native frame (no path) tells us nothing safe to keep
    const rel = appRelative(path[0]);
    if (!rel) continue; // node_modules, a user repo, ~/.claude — dropped
    out.push(stripSecrets(line.replace(path[0], rel)));
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/** A short, inert label: letters, digits, spaces and dashes only. */
function safeField(v: unknown, max = MAX_FIELD): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^A-Za-z0-9._+ -]/g, "").trim().slice(0, max);
  return s || undefined;
}

export function scrub(d: Diagnostic): SafeReport {
  const err = d?.error;
  const errObj = (err && typeof err === "object" ? (err as { name?: unknown; message?: unknown; stack?: unknown }) : {});
  const errorType = (String(errObj.name ?? "Error").replace(/[^A-Za-z0-9_$]/g, "").slice(0, 60)) || "Error";
  const rawMsg = typeof err === "string" ? err : String(errObj.message ?? "");
  const message = redactText(rawMsg).slice(0, MAX_MSG);
  const frames = typeof errObj.stack === "string" ? scrubFrames(errObj.stack) : [];

  const report: SafeReport = {
    errorType,
    message,
    frames,
    app: { version: safeField(d?.app?.version), commit: safeField(d?.app?.commit) },
    runtime: {
      os: safeField(d?.runtime?.os),
      arch: safeField(d?.runtime?.arch),
      bun: safeField(d?.runtime?.bun),
      electron: safeField(d?.runtime?.electron),
    },
  };
  const category = safeField(d?.category, MAX_CATEGORY);
  if (category) report.category = category;
  return report;
}
