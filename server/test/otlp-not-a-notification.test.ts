// An unrecognised GenAI record is telemetry, not a request for a human.
//
// The mapper's catch-all turned ANY GenAI-tagged log record it had not learned
// into `Notification`. That is not a neutral bucket — it is the vocabulary's
// word for "the agent wants you", and three things act on it:
//
//   web/lib/derive.ts:337   the fleet card turns to `waiting`
//   web/lib/derive.ts:399   the outcome ladder counts it `unanswered`
//   server/alerts.ts:119    a desktop notification fires, and the webhook
//
// So a Codex heartbeat, a rollout debug line, or any vendor record newer than
// this mapper told the operator an agent was blocked on them — on their desk,
// on their phone, and in whatever Slack channel AGENTGLASS_WEBHOOK points at.
// A false "needs you" is the most expensive signal this product can emit,
// because the queue is the product. And it fired on the path agentglass
// advertises as provider-agnostic, which is the path with the most unknown
// record shapes by definition.
import { describe, expect, test } from "bun:test";
import { otlpLogsToEvents } from "../src/otlp.ts";

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});

const record = (attrs: ReturnType<typeof kv>[], body?: string) => ({
  resourceLogs: [{
    resource: { attributes: [kv("service.name", "codex_cli_rs")] },
    scopeLogs: [{
      logRecords: [{
        timeUnixNano: "1700000000000000000",
        attributes: [kv("gen_ai.system", "openai"), kv("conversation.id", "c1"), ...attrs],
        ...(body ? { body: { stringValue: body } } : {}),
      }],
    }],
  }],
});

const typeOf = (attrs: ReturnType<typeof kv>[], body?: string) =>
  otlpLogsToEvents(record(attrs, body))[0]?.hook_event_type;

describe("records that do not ask for anything are not made to", () => {
  for (const kind of [
    "rollout.debug.heartbeat",
    "stream.chunk",
    "some.vendor.event.from.the.future",
    "response.metadata",
  ]) {
    test(`"${kind}" is telemetry`, () => {
      expect(typeOf([kv("event.kind", kind)], "…")).toBe("Telemetry");
    });
  }

  test("a bare body with no event kind is telemetry too", () => {
    expect(typeOf([], "some log line")).toBe("Telemetry");
  });
});

describe("a record that IS asking for a human still says so", () => {
  // Losing this would be the opposite failure, and a worse one: a genuine
  // hold going unannounced.
  for (const kind of [
    "notification.idle_prompt",
    "permission.request",
    "approval.needed",
    "agent.blocked",
    "awaiting.user",
    "input_required",
  ]) {
    test(`"${kind}" is a Notification`, () => {
      expect(typeOf([kv("event.kind", kind)], "…")).toBe("Notification");
    });
  }
});

describe("the branches above the catch-all are untouched", () => {
  test("a tool call is still a tool call", () => {
    expect(typeOf([kv("event.kind", "tool.decision"), kv("gen_ai.tool.name", "bash")])).toBe("PreToolUse");
  });

  test("a tool result is still a tool result", () => {
    expect(typeOf([kv("event.kind", "tool.result"), kv("gen_ai.tool.name", "bash")])).toBe("PostToolUse");
  });

  test("a token-bearing record is still a costed turn", () => {
    expect(typeOf([kv("event.kind", "rollout.debug.heartbeat"), kv("input_token_count", 100)])).toBe("Turn complete");
  });

  test("a prompt is still a prompt", () => {
    expect(typeOf([kv("event.kind", "user.message")], "hi")).toBe("UserPromptSubmit");
  });

  test("a session start is still a session start", () => {
    expect(typeOf([kv("event.kind", "session.start")], "…")).toBe("SessionStart");
  });

  test("an empty record is still dropped rather than invented", () => {
    expect(typeOf([])).toBeUndefined();
  });
});
