import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedServer,
  normalizeServer,
  resolveServer,
  limitToolOutput,
  AgentGlassPlugin,
} from "./opencode-plugin.js";

test("OpenCode telemetry allows only local servers by default", () => {
  assert.equal(isAllowedServer("http://localhost:4000"), true);
  assert.equal(isAllowedServer("https://127.0.0.1:4000"), true);
  assert.equal(isAllowedServer("http://[::1]:4000"), true);
  assert.equal(isAllowedServer("https://example.com"), false);
  assert.equal(isAllowedServer("not a url"), false);
});

test("OpenCode telemetry allows an explicit remote opt-out", () => {
  assert.equal(isAllowedServer("https://example.com", true), true);
});

test("OpenCode telemetry normalizes trailing server slashes", () => {
  assert.equal(normalizeServer("http://localhost:4000///"), "http://localhost:4000");
});

test("OpenCode telemetry accepts the legacy server variable", () => {
  assert.equal(
    resolveServer({ AGENTGLASS_URL: "http://localhost:5000/" }),
    "http://localhost:5000",
  );
  assert.equal(
    resolveServer({
      AGENTGLASS_SERVER: "http://localhost:6000",
      AGENTGLASS_URL: "http://localhost:5000",
    }),
    "http://localhost:6000",
  );
});

test("OpenCode telemetry bounds tool output", () => {
  const text = "x".repeat(300_000);
  const limited = limitToolOutput(text);
  assert.ok(limited.length < text.length);
  assert.match(limited, /output truncated/);
});

test("OpenCode emits one Stop for a completed assistant turn", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("", { status: 200 });
  };
  try {
    const plugin = await AgentGlassPlugin({ directory: "/tmp/project" });
    const info = {
      id: "msg-1",
      sessionID: "session-1",
      role: "assistant",
      finish: "stop",
      tokens: { input: 10, output: 20 },
    };
    await plugin.event({ event: { type: "message.updated", properties: { sessionID: "session-1", info } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    assert.equal(sent.filter((body) => body.hook_event_type === "Stop").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
