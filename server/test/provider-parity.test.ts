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
let webModelLabelOf: (m: string | null | undefined) => string;
let serverModelLabel: (m: string | null | undefined) => string;

beforeAll(async () => {
  serverProviderOf = (await import("../src/db.ts")).providerOf;
  serverModelLabel = (await import("../src/pricing.ts")).modelLabel;
  const format = await import("../../web/src/lib/format.ts");
  webProviderOf = format.providerOf;
  webModelLabelOf = format.modelLabelOf;
});

// One real id per branch of the mapping, plus the ones that must fall through.
const MODELS = [
  "claude-opus-4-8", "claude-sonnet-5", "claude-3-5-haiku", "claude-fable-5", "anthropic.claude-v2",
  "gpt-4o", "gpt-4.1", "o1-preview", "o3-mini", "o4-mini", "davinci-002", "openai/gpt-5",
  "gemini-2.5-pro", "models/gemini-1.5-flash", "text-bison", "palm-2", "vertex_ai/gemini",
  "deepseek-chat", "grok-2", "xai/grok", "mistral-large", "mixtral-8x7b", "codestral",
  "llama-3.1-70b", "meta-llama/Llama-3", "command-r-plus", "cohere.command",
  "k3", "kimi-k3", "kimi-code/k3", "moonshot-v1-128k",
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

  test("Kimi K3 aliases resolve to Moonshot and the K3 display label", () => {
    for (const model of ["k3", "kimi-k3", "kimi-code/k3"]) {
      expect(serverProviderOf(model)).toBe("Moonshot");
      expect(webProviderOf(model)).toBe("Moonshot");
      expect(webModelLabelOf(model)).toBe("K3");
    }
  });
});

// The other half of the same class of bug, and the one that actually shipped.
// providerOf was pinned here by #282; the display label was not, and it had
// drifted: server modelLabel() returned the matched PRICE ROW's name, and a
// price row buckets several ids on purpose. So "gpt-5" priced from the GPT-4.1
// row was *called* "GPT-4.1" by the cost donut while the fleet card beside it
// said "GPT-5" — one model, two names, two hash-derived colours, on one screen.
//
// Both sides now come from shared/models.ts. This is what stops the split
// reopening the next time a rate row is made to cover one more id.
describe("modelLabel agrees between the server and the web copy", () => {
  const LABELLED = [
    ...MODELS,
    // The families where a rate row deliberately covers several models — the
    // exact shape that used to collapse them all onto one name.
    "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.5",
    "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4-turbo",
    "claude-opus-4-1", "claude-opus-4-5", "claude-3-5-sonnet-20241022",
    "mythos-1", "k3[512k]",
  ];
  for (const m of LABELLED) {
    test(`"${m}" is called the same thing on both sides`, () => {
      expect(serverModelLabel(m)).toBe(webModelLabelOf(m));
    });
  }

  test("null / undefined agree", () => {
    expect(serverModelLabel(null)).toBe(webModelLabelOf(null));
    expect(serverModelLabel(undefined)).toBe(webModelLabelOf(undefined));
  });

  // The regression that motivated all of this, stated as itself.
  test("a GPT-5 id is not called GPT-4.1", () => {
    expect(serverModelLabel("gpt-5")).toBe("GPT-5");
    expect(serverModelLabel("gpt-5-mini")).toBe("GPT-5 mini");
  });

  // A price row may still bucket ids together — that is its job. What it may
  // no longer do is decide what they are called.
  test("a shared rate row does not merge two models' names", async () => {
    const { priceFor } = await import("../src/pricing.ts");
    expect(priceFor("gpt-5")?.input).toBe(priceFor("gpt-4.1")?.input);
    expect(serverModelLabel("gpt-5")).not.toBe(serverModelLabel("gpt-4.1"));
  });
});
