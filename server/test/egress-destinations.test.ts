import { describe, expect, test } from "bun:test";
import { outboundDestination, webhookDestination } from "../src/egress.ts";
import { anthropicClientOptions, walkthroughEnabled } from "../src/walkthrough.ts";
import { nudgeChannel, sendNudge } from "../src/prnudge.ts";

describe("environment-configured outbound destinations", () => {
  const env = (values: Record<string, string> = {}) => values;

  test("allows loopback integrations without a remote opt-in", () => {
    for (const url of ["http://localhost:4000/hook", "http://127.0.0.1:4000/hook", "http://[::1]:4000/hook"]) {
      expect(outboundDestination(url, "TEST_URL", [], env()).ok, url).toBe(true);
    }
  });

  test("refuses remote destinations unless the opt-in is exactly 1", () => {
    for (const value of [undefined, "", "0", "false", "yes"]) {
      const values: Record<string, string | undefined> = { AGENTGLASS_ALLOW_REMOTE: value };
      const result = outboundDestination("https://hooks.example.test/a-secret", "TEST_URL", [], values);
      expect(result.ok, String(value)).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("AGENTGLASS_ALLOW_REMOTE=1");
        expect(result.error).not.toContain("a-secret");
      }
    }
    expect(outboundDestination(
      "https://hooks.example.test/a-secret",
      "TEST_URL",
      [],
      env({ AGENTGLASS_ALLOW_REMOTE: "1" }),
    ).ok).toBe(true);
  });

  test("rejects malformed and non-HTTP destinations before fetch", () => {
    expect(outboundDestination("not a url", "TEST_URL").ok).toBe(false);
    expect(outboundDestination("file:///tmp/hook", "TEST_URL").ok).toBe(false);
  });

  test("applies the same guard to the shared alerts and nudge webhook", () => {
    const blocked = webhookDestination(env({ AGENTGLASS_WEBHOOK: "https://hooks.example.test/x" }));
    expect(blocked.configured).toBe(false);
    if (!blocked.configured) expect(blocked.error).toContain("AGENTGLASS_ALLOW_REMOTE=1");

    expect(webhookDestination(env({
      AGENTGLASS_WEBHOOK: "https://hooks.example.test/x",
      AGENTGLASS_ALLOW_REMOTE: "1",
    })).configured).toBe(true);
  });

  test("the PR nudge sender reports a blocked remote channel instead of posting", async () => {
    const webhook0 = process.env.AGENTGLASS_WEBHOOK;
    const allow0 = process.env.AGENTGLASS_ALLOW_REMOTE;
    process.env.AGENTGLASS_WEBHOOK = "https://hooks.example.test/x";
    delete process.env.AGENTGLASS_ALLOW_REMOTE;
    try {
      expect(nudgeChannel().configured).toBe(false);
      const result = await sendNudge("hello");
      expect(result.sent).toBe(false);
      expect(result.error).toContain("AGENTGLASS_ALLOW_REMOTE=1");
    } finally {
      if (webhook0 === undefined) delete process.env.AGENTGLASS_WEBHOOK;
      else process.env.AGENTGLASS_WEBHOOK = webhook0;
      if (allow0 === undefined) delete process.env.AGENTGLASS_ALLOW_REMOTE;
      else process.env.AGENTGLASS_ALLOW_REMOTE = allow0;
    }
  });

  test("allows Anthropic's endpoint but guards custom remote base URLs", () => {
    expect(anthropicClientOptions(env({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })))
      .toEqual({ baseURL: "https://api.anthropic.com/" });
    expect(() => anthropicClientOptions(env({ ANTHROPIC_BASE_URL: "https://proxy.example.test" })))
      .toThrow("AGENTGLASS_ALLOW_REMOTE=1");
    expect(anthropicClientOptions(env({
      ANTHROPIC_BASE_URL: "https://proxy.example.test",
      AGENTGLASS_ALLOW_REMOTE: "1",
    }))).toEqual({ baseURL: "https://proxy.example.test/" });
  });
});

describe("walkthrough kill switch", () => {
  test("literal 1 disables both CLI and API providers", () => {
    expect(walkthroughEnabled({ AGENTGLASS_WALKTHROUGH_DISABLED: "1", ANTHROPIC_API_KEY: "set" }, "/bin/claude"))
      .toBe(false);
  });

  test("other values do not accidentally disable available providers", () => {
    expect(walkthroughEnabled({ AGENTGLASS_WALKTHROUGH_DISABLED: "0", ANTHROPIC_API_KEY: "set" }, null)).toBe(true);
    expect(walkthroughEnabled({}, "/bin/claude")).toBe(true);
    expect(walkthroughEnabled({}, null)).toBe(false);
  });
});
