import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedServer,
  normalizeServer,
  resolveServer,
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
