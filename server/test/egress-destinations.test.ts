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

/*
 * AGENTGLASS_WEBHOOK is documented as "a Slack- or Discord-shaped incoming
 * webhook", so gating exactly those two hosts behind AGENTGLASS_ALLOW_REMOTE
 * would gate the feature on its own purpose — every existing install would go
 * quiet on upgrade, with a line on stderr as the only explanation.
 *
 * The line drawn instead is by payload: the webhook carries notification text
 * to a channel somebody pasted a URL for, while ANTHROPIC_BASE_URL carries
 * repository code. So the two service hosts are trusted here and nowhere else.
 */
describe("the hosts the webhook exists for", () => {
  const webhook = (url: string, allow?: string) => webhookDestination(
    allow ? { AGENTGLASS_WEBHOOK: url, AGENTGLASS_ALLOW_REMOTE: allow } : { AGENTGLASS_WEBHOOK: url },
  );

  test("Slack and Discord need no opt-in", () => {
    for (const url of [
      "https://hooks.slack.com/services/T000/B000/xxxx",
      "https://discord.com/api/webhooks/1/xxxx",
      "https://discordapp.com/api/webhooks/1/xxxx",
    ]) {
      expect(webhook(url).configured, url).toBe(true);
    }
  });

  test("anything else still does", () => {
    expect(webhook("https://hooks.example.test/x").configured).toBe(false);
    expect(webhook("https://hooks.example.test/x", "1").configured).toBe(true);
    // A host that merely ends in a trusted name is not that host.
    expect(webhook("https://hooks.slack.com.evil.test/x").configured).toBe(false);
  });

  test("the trusted list does not leak into the walkthrough's destination", () => {
    // Different payload, different rule: repository code goes to Anthropic or
    // nowhere, whatever the webhook is allowed to reach.
    expect(outboundDestination(
      "https://hooks.slack.com/services/T000/B000/xxxx",
      "ANTHROPIC_BASE_URL",
      ["api.anthropic.com"],
      {},
    ).ok).toBe(false);
  });
});

describe("what counts as this machine", () => {
  test("the whole loopback range, not just 127.0.0.1", () => {
    // A server bound to 127.0.0.2 is as local as one on 127.0.0.1, and a guard
    // that disagrees with the OS about that refuses a working local setup.
    for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3"]) {
      expect(outboundDestination(`http://${host}:4000/hook`, "TEST_URL", [], {}).ok, host).toBe(true);
    }
    // Neighbouring addresses that only look loopback are still remote.
    for (const host of ["127.0.0.1.evil.test", "128.0.0.1", "10.0.0.1"]) {
      expect(outboundDestination(`http://${host}:4000/hook`, "TEST_URL", [], {}).ok, host).toBe(false);
    }
  });
});
