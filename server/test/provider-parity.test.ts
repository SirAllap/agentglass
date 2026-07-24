// providerOf is derived TWICE — server-side in db.ts (which decides scope
// buckets and the sessions.provider column) and client-side in web/format.ts
// (which decides the Fleet badge and the filter dropdown). Their comments say
// "kept in sync", but nothing enforced it: adding a model rule to one copy and
// forgetting the other would bucket the same model under two different providers
// in two panels — the #246 class of inconsistency. This pins the two together.
//
// The only intended difference is the miss value — the server returns null (the
// column is NULL), the web returns "unknown" (the label). #246 depends on that
// exact correspondence (the web's "unknown" round-trips to the server's NULL
// bucket), so it is normalised here rather than treated as a divergence.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTGLASS_DB = join(mkdtempSync(join(tmpdir(), "agx-prov-")), "p.db");

let serverProviderOf: (m: string | null | undefined) => string | null;
let webProviderOf: (m: string | null | undefined) => string;

beforeAll(async () => {
  serverProviderOf = (await import("../src/db.ts")).providerOf;
  webProviderOf = (await import("../../web/src/lib/format.ts")).providerOf;
});

// One real id per branch of the mapping, plus the ones that must fall through.
const MODELS = [
  "claude-opus-4-8", "claude-sonnet-5", "claude-3-5-haiku", "claude-fable-5", "anthropic.claude-v2",
  "gpt-4o", "gpt-4.1", "o1-preview", "o3-mini", "o4-mini", "davinci-002", "openai/gpt-5",
  "gemini-2.5-pro", "models/gemini-1.5-flash", "text-bison", "palm-2", "vertex_ai/gemini",
  "deepseek-chat", "grok-2", "xai/grok", "mistral-large", "mixtral-8x7b", "codestral",
  "llama-3.1-70b", "meta-llama/Llama-3", "command-r-plus", "cohere.command",
  // fall-through cases — must be the miss bucket on both sides
  "some-unknown-model", "qwen-2.5", "", "   ", "MODEL-WITH-NO-MATCH",
];

const norm = (v: string | null): string => v ?? "unknown"; // server NULL === web "unknown"

describe("providerOf agrees between the server and the web copy", () => {
  for (const m of MODELS) {
    test(`"${m}" buckets the same on both sides`, () => {
      expect(norm(serverProviderOf(m))).toBe(webProviderOf(m));
    });
  }

  test("null / undefined agree (the miss bucket)", () => {
    expect(norm(serverProviderOf(null))).toBe(webProviderOf(null));
    expect(norm(serverProviderOf(undefined))).toBe(webProviderOf(undefined));
  });
});
