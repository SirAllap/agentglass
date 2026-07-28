// LLM walkthrough: an AI-authored review itinerary for a burst of agent changes.
//
// Primary provider is the machine's LOCAL Claude Code CLI (`claude -p`), so it
// reuses the existing login on the PC — no separate API key needed. Falls back
// to the Anthropic SDK when ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set and
// the CLI isn't available.
//
// Following codiff's anti-hallucination trick, the model never returns code — it
// returns only a per-file one-line description + a change tag + a one-line
// "review focus". The diffs remain the source of truth (telemetry / git).

import Anthropic from "@anthropic-ai/sdk";
import type { WalkthroughResult, WalkthroughInputFile } from "../../shared/types.ts";
import { stripSecrets } from "../../shared/scrub.ts";

// Haiku by default: the task is a one-liner per file, so a small fast model is
// plenty and keeps latency + token cost low. Override with the env var to trade
// speed for depth (e.g. claude-opus-5). Results are cached client-side, so the
// model only runs on genuinely new changesets.
const MODEL = process.env.AGENTGLASS_WALKTHROUGH_MODEL || "claude-haiku-4-5";
const MAX_FILES = 40;
const MAX_PATCH_LINES = 90;
// A hard ceiling on the local `claude` call. Without it a hung CLI — a stuck
// login refresh, a wedged model request — holds the request open forever and
// leaks the child, the same failure mode the other spawns in this repo already
// guard against. Two minutes is well past a one-line-per-file summary on Haiku
// while still bounding the worst case.
const CLI_TIMEOUT_MS = 120_000;

const claudeBin = () => Bun.which("claude");
const hasApiKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Enabled if either the local Claude Code CLI is on PATH or an API key is set. */
export const WALKTHROUGH_ENABLED = !!claudeBin() || hasApiKey();

const SYSTEM = [
  "You review bursts of file changes made by AI coding agents in a repository.",
  "For EACH file, write ONE concise, specific sentence describing what changed and why —",
  "imperative voice, no fluff, do not restate the filename, do not say \"this file\".",
  "Classify each file with a single tag. Then write one 'reviewFocus' line (<= 120 chars)",
  "summarizing the whole change set at a glance.",
  "Only describe changes actually present in the diffs — never invent behavior.",
].join(" ");

// JSON schema for the SDK path (structured outputs enforce it server-side).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviewFocus: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          description: { type: "string" },
          tag: { type: "string", enum: ["feature", "fix", "refactor", "test", "docs", "config", "style", "chore"] },
        },
        required: ["path", "description", "tag"],
      },
    },
  },
  required: ["reviewFocus", "files"],
} as const;

// Human-readable shape for the CLI path (no structured-output enforcement).
const SCHEMA_HINT = '{"reviewFocus": string, "files": [{"path": string, "description": string, "tag": "feature"|"fix"|"refactor"|"test"|"docs"|"config"|"style"|"chore"}]}';

/**
 * Files whose whole purpose is a credential.
 *
 * Explain sends real changed lines to a model — the local `claude` CLI or the
 * API, both of which leave this machine. That is the feature working, and it is
 * fine for source. It is not fine for the file you keep your keys in, and
 * nothing was stopping it: `git diff` on a modified `.env` produced `+` lines,
 * and every `+` line went into the prompt.
 *
 * Matched on the basename so a path anywhere in the tree is caught, and kept
 * deliberately blunt. A false positive costs one file's summary; a false
 * negative sends somebody's production credentials to a model.
 */
const SECRET_FILES: RegExp[] = [
  /^\.env(\.|$)/i, // .env, .env.local, .env.production
  /^\.?(npmrc|netrc|pgpass|htpasswd)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  // Any extension, not a list of them: `secrets.tfvars.json` and
  // `credentials.enc.yaml` are exactly the shapes an extension allowlist
  // misses. Anchored on a dot so `secrets-policy.md` is still prose.
  /^(credentials?|secrets?|service-account[^/]*)\./i,
  /^(secring|master\.key)$/i,
];

/** Whether a changed file is one whose contents are a credential by design. */
export function isSecretFile(path: string): boolean {
  const base = (path || "").replace(/\\/g, "/").split("/").pop() || "";
  return SECRET_FILES.some((re) => re.test(base));
}

// Keep only what the model needs to summarize: hunk headers + added/removed
// lines. Dropping context lines (the usual majority) roughly halves the input
// tokens with no loss for a one-line-per-file summary.
function compressPatch(patch: string): string {
  const out: string[] = [];
  for (const ln of (patch || "").split("\n")) {
    if (ln.startsWith("--- ") || ln.startsWith("+++ ")) continue; // redundant with `path`
    if (ln.startsWith("@@") || ln.startsWith("+") || ln.startsWith("-")) out.push(ln);
  }
  return out.slice(0, MAX_PATCH_LINES).join("\n");
}

/**
 * What actually goes to the model, and what was held back.
 *
 * Withheld files are *reported*, never silently dropped: a summary that
 * describes a different changeset from the one on screen is worse than no
 * summary, because it is trusted. The name still goes — the model can say "a
 * config file changed" — and only the contents stay behind.
 *
 * The patches that do go through `stripSecrets` as well, using the same
 * definition of a credential the crash reporter already uses (#207): a key
 * pasted into an ordinary source file is not caught by any filename rule.
 */
type SentFile = { path: string; tool?: string; additions?: number; deletions?: number; patch: string };

export function trimFiles(files: WalkthroughInputFile[]): { sent: SentFile[]; withheld: string[] } {
  const withheld: string[] = [];
  const sent = (files ?? []).slice(0, MAX_FILES).map((f) => {
    if (isSecretFile(f.path)) {
      withheld.push(f.path);
      return { path: f.path, tool: f.tool, additions: f.additions, deletions: f.deletions, patch: "" };
    }
    return {
      path: f.path,
      tool: f.tool,
      additions: f.additions,
      deletions: f.deletions,
      patch: stripSecrets(compressPatch(f.patch || "")),
    };
  });
  return { sent, withheld };
}

function extractJson(text: string): { reviewFocus?: unknown; files?: unknown } {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function shape(parsed: { reviewFocus?: unknown; files?: unknown }): WalkthroughResult {
  return {
    available: true,
    reviewFocus: typeof parsed.reviewFocus === "string" ? parsed.reviewFocus : "",
    files: Array.isArray(parsed.files) ? (parsed.files as WalkthroughResult["files"]) : [],
  };
}

/** Primary path: drive the local `claude` CLI headlessly, reusing its login. */
async function viaClaudeCli(sent: SentFile[]): Promise<WalkthroughResult> {
  const bin = claudeBin();
  if (!bin) throw new Error("claude CLI not found");
  const prompt = [
    SYSTEM,
    "",
    "Respond with ONLY a JSON object (no prose, no code fence) of this exact shape:",
    SCHEMA_HINT,
    "",
    "Files changed (unified diffs):",
    JSON.stringify(sent, null, 2),
  ].join("\n");

  const proc = Bun.spawn([bin, "-p", "--output-format", "json", "--max-turns", "1", "--model", MODEL], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
    // Mark this as an internal call so agentglass's own hooks skip it (no
    // phantom "walkthrough" session shows up in the dashboard).
    env: { ...process.env, AGENTGLASS_INTERNAL: "1" },
  });
  // Kill a hung CLI rather than await it forever; the timer is cleared once the
  // process settles, so a normal run pays nothing for it.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already gone */ } }, CLI_TIMEOUT_MS);
  let out: string, err: string, code: number;
  try {
    [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error(`claude timed out after ${CLI_TIMEOUT_MS / 1000}s`);
  if (code !== 0) throw new Error(err.trim() || `claude exited with code ${code}`);

  // `--output-format json` wraps the answer in an envelope with a `.result` string.
  let resultText = out;
  try {
    const env = JSON.parse(out);
    if (env && typeof env.result === "string") resultText = env.result;
  } catch {
    /* stdout was already the plain answer */
  }
  return shape(extractJson(resultText));
}

/** Fallback path: Anthropic SDK with structured outputs (needs an API key). */
async function viaApi(sent: SentFile[]): Promise<WalkthroughResult> {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> }, effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: "Files changed (unified diffs):\n\n" + JSON.stringify(sent, null, 2) }],
  });
  const block = res.content.find((b) => b.type === "text");
  return shape(block && block.type === "text" ? JSON.parse(block.text) : {});
}

export async function generateWalkthrough(files: WalkthroughInputFile[]): Promise<WalkthroughResult> {
  if (!WALKTHROUGH_ENABLED) {
    return {
      available: false,
      reviewFocus: "",
      files: [],
      error: "no local `claude` CLI and no ANTHROPIC_API_KEY — install Claude Code or set a key to enable walkthroughs",
    };
  }
  // Filtered once, before either path can see it: the two transports are
  // different ways off this machine, not different trust levels.
  const { sent, withheld } = trimFiles(files);
  if (claudeBin()) {
    try {
      return { ...(await viaClaudeCli(sent)), withheld };
    } catch (e) {
      if (!hasApiKey()) throw e; // no fallback available — surface the error
      // otherwise fall through to the API path
    }
  }
  return { ...(await viaApi(sent)), withheld };
}
