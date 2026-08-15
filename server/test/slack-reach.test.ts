/*
 * Whether the agent on this machine can post to Slack.
 *
 * Worth a test file of its own because the first answer was wrong in the way
 * that is hardest to notice: it said "not connected" on a machine where
 * `claude mcp list` reported `slack: https://mcp.slack.com/mcp - Connected`.
 * An HTTP MCP authorised through OAuth is not written to `~/.claude.json` or a
 * project `.mcp.json` at all — those hold servers configured by hand — it lives
 * in `~/.claude/.credentials.json` under `mcpOAuth`.
 *
 * The other half of these tests is about what is NOT read. That file holds live
 * tokens, and the config beside it holds counters that only say how often
 * somebody was shown an advert for the integration.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackReachable } from "../src/slackreach.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-slack-"));
let n = 0;
const write = (name: string, body: unknown) => {
  const p = join(dir, `${n++}-${name}`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const NONE = write("empty.json", {});

describe("finding a Slack connection", () => {
  it("finds one authorised through OAuth, keyed name|hash", () => {
    // The shape on a real machine, and the case the first version missed.
    const creds = write("creds.json", { mcpOAuth: { "slack|38801a7d845718b3": { serverUrl: "https://mcp.slack.com/mcp" } } });
    expect(slackReachable(NONE, creds)).toBe(true);
  });

  it("finds one named something else, by the server's HOST", () => {
    /* Checked as a host and not as a substring: a URL merely containing the
       word would be a far weaker claim than the host being Slack's. */
    const creds = write("creds2.json", { mcpOAuth: { "chat|abc": { serverUrl: "https://mcp.slack.com/mcp" } } });
    expect(slackReachable(NONE, creds)).toBe(true);
  });

  it("finds one configured by hand, globally or under a project", () => {
    const g = write("global.json", { mcpServers: { slack: {} } });
    expect(slackReachable(g, NONE)).toBe(true);
    const p = write("proj.json", { projects: { "/home/someone/code/shop-api": { mcpServers: { "slack-mcp": {} } } } });
    expect(slackReachable(p, NONE)).toBe(true);
  });

  it("says no when the only servers are other things", () => {
    const g = write("other.json", { projects: { "/x": { mcpServers: { clickup: {}, playwright: {} } } } });
    const c = write("othercreds.json", { mcpOAuth: { "figma|1": { serverUrl: "https://mcp.figma.com/mcp" } } });
    expect(slackReachable(g, c)).toBe(false);
  });

  it("is not fooled by a host that merely ends in something similar", () => {
    // `notslack.com` is not Slack, and neither is `slack.com.evil.test`.
    const c = write("lookalike.json", { mcpOAuth: { "x|1": { serverUrl: "https://mcp.notslack.com/mcp" } } });
    expect(slackReachable(NONE, c)).toBe(false);
    const c2 = write("lookalike2.json", { mcpOAuth: { "x|1": { serverUrl: "https://slack.com.evil.test/mcp" } } });
    expect(slackReachable(NONE, c2)).toBe(false);
  });

  it("ignores the counters that only say an advert was shown", () => {
    /* `tipsHistory.install-slack-app` and the banner gate both live in the real
       config and both count impressions. Believing them lights the button up
       for everyone who has ever declined the integration. */
    const g = write("tips.json", {
      tipsHistory: { "install-slack-app": 32649, "install-slack-app-mcp": 32636 },
      cachedStatsigGates: { code_slack_app_install_banner: false },
    });
    expect(slackReachable(g, NONE)).toBe(false);
  });

  it("answers no rather than throwing when the files are missing or junk", () => {
    // It runs on a route that renders a button; a throw there is a blank panel.
    expect(slackReachable(join(dir, "nope.json"), join(dir, "nope2.json"))).toBe(false);
    const bad = write("bad.json", "{ not json");
    expect(slackReachable(bad, bad)).toBe(false);
  });

  it("returns a boolean and nothing else, because the file holds live tokens", () => {
    const creds = write("secret.json", { mcpOAuth: { "slack|h": { serverUrl: "https://mcp.slack.com/mcp", accessToken: "xoxp-do-not-leak" } } });
    expect(slackReachable(NONE, creds)).toBe(true);
  });
});
