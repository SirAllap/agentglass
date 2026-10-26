// The Codex backend's two pure pieces: the argv a turn is spawned with, and the
// model list the dropdown is offered.
//
// Both are worth pinning without a real `codex`. The argv decides how much a
// browser request may do to the filesystem, and the model list is read off a
// cache this repo does not control — a shape change there must degrade to the
// fallback rather than putting a malformed id into the spawn.
//
// The third is the rollout reader, which is what gives a resumed Codex chat its
// history: the telemetry the fleet knows a Codex session by carries the shape of
// a turn but none of its words (its `UserPromptSubmit` payload is literally
// `{"prompt":""}`), so this file on disk is the only source for them.
import { describe, expect, test } from "bun:test";
import { codexArgs, parseModels, DEFAULT_SANDBOX } from "../src/codex.ts";

const BIN = "/usr/bin/codex";

describe("codexArgs", () => {
  test("a first turn opens a thread and reads the prompt from stdin", () => {
    expect(codexArgs(BIN, "gpt-5.6-sol", "read-only", "")).toEqual([
      BIN, "exec", "--json", "-m", "gpt-5.6-sol",
      "-c", "sandbox_mode=read-only",
      "-c", "approval_policy=never",
      "-",
    ]);
  });

  test("a follow-up resumes the thread it was given", () => {
    const args = codexArgs(BIN, "gpt-5.6-sol", "workspace-write", "019fb8f6-aabc-72e3-80fe-66edcdf559f5");
    expect(args.slice(0, 4)).toEqual([BIN, "exec", "resume", "019fb8f6-aabc-72e3-80fe-66edcdf559f5"]);
    expect(args).toContain("--json");
    expect(args).toContain("sandbox_mode=workspace-write");
    // `codex exec resume` rejects `-s` outright, which is why the sandbox rides
    // in as a config override on both paths rather than as the documented flag.
    expect(args).not.toContain("-s");
    expect(args[args.length - 1]).toBe("-");
  });

  test("full-access drops the sandbox instead of narrowing it", () => {
    const args = codexArgs(BIN, "gpt-5.6-sol", "full-access", "");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // No sandbox_mode alongside it: the two would be contradictory, and the
    // bypass flag already implies the approval policy.
    expect(args.some((a) => a.startsWith("sandbox_mode="))).toBe(false);
    expect(args.some((a) => a.startsWith("approval_policy="))).toBe(false);
  });

  test("the prompt is never an argv element", () => {
    // It goes in on stdin. A prompt in argv would hit ARG_MAX on a long paste
    // and would put what the user typed into the process table.
    const args = codexArgs(BIN, "gpt-5.6-sol", "read-only", "");
    expect(args.filter((a) => a === "-")).toHaveLength(1);
    expect(args).not.toContain("hello");
  });

  test("the default sandbox is the one that cannot write", () => {
    expect(DEFAULT_SANDBOX).toBe("read-only");
  });
});

/** One entry shaped like the real cache, trimmed to the fields that matter. */
const model = (o: Record<string, unknown>) => ({
  slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1,
  description: "…", base_instructions: "…several kilobytes…", ...o,
});

describe("parseModels", () => {
  test("keeps listed models, in priority order, as id and label only", () => {
    const raw = JSON.stringify({
      models: [
        model({ slug: "gpt-5.5", display_name: "GPT-5.5", priority: 3 }),
        model({ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", priority: 1 }),
        model({ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", priority: 2 }),
      ],
    });
    expect(parseModels(raw)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
  });

  test("drops entries Codex does not itself offer to a human", () => {
    // The cache carries internal entries — a review model, service tiers — that
    // are not conversation models at all.
    const raw = JSON.stringify({
      models: [model({ slug: "codex-auto-review", visibility: "hidden" }), model({})],
    });
    expect(parseModels(raw).map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  test("drops an id the send path would then refuse", () => {
    // Offering a choice that fails validation on the way out is the one outcome
    // worth ruling out here — it would read as the chat being broken.
    const raw = JSON.stringify({
      models: [model({ slug: "gpt-5.6 --dangerously-bypass-approvals-and-sandbox" }), model({ slug: "GPT-Upper" }), model({})],
    });
    expect(parseModels(raw).map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  test("falls back to the slug when there is no display name", () => {
    expect(parseModels(JSON.stringify({ models: [model({ display_name: null })] })))
      .toEqual([{ id: "gpt-5.6-sol", label: "gpt-5.6-sol" }]);
  });

  test("a cache that is missing, malformed or reshaped yields nothing", () => {
    // Nothing here throws — codexModels() reads the emptiness as "use the
    // fallback list", which is what keeps a Codex release from emptying the
    // dropdown on a machine where the CLI works fine.
    expect(parseModels("")).toEqual([]);
    expect(parseModels("not json")).toEqual([]);
    expect(parseModels("{}")).toEqual([]);
    expect(parseModels(JSON.stringify({ models: "gpt-5.6-sol" }))).toEqual([]);
    expect(parseModels(JSON.stringify({ models: [null, 42, "x"] }))).toEqual([]);
  });
});
