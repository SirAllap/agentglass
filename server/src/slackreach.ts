import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether the agent on this machine can post to Slack.
 *
 * agentglass does not talk to Slack and should not: it would mean holding a
 * workspace token to do something the agent already does with its own. So the
 * button here writes the message and hands it to a chat — the same shape as
 * "Review with Claude" — and this decides whether to offer the button at all.
 *
 * What is being asked is narrow and answerable: does the agent have Slack
 * connected. Getting the ANSWER right took two tries, and the first one is
 * worth writing down because it looked correct.
 *
 * Slack was reported as not connected on a machine where `claude mcp list` says
 * `slack: https://mcp.slack.com/mcp - Connected`. The reason: an HTTP MCP that
 * was authorised through OAuth is not written to `~/.claude.json` or to a
 * project `.mcp.json` at all. Those hold servers somebody configured by hand.
 * The OAuth'd ones live in `~/.claude/.credentials.json` under `mcpOAuth`,
 * keyed `<name>|<hash>` with the server's URL beside them.
 *
 * Both are read, because both are real ways to have it. And the tip counters in
 * `~/.claude.json` — `tipsHistory.install-slack-app`, the
 * `code_slack_app_install_banner` gate — are read by NEITHER: those count how
 * often somebody was shown an advert for the integration, so believing them
 * lights the button up for everyone who has ever declined it.
 *
 * **Only key names and the server host are ever looked at.** That file holds
 * live tokens; nothing from it is returned, logged, or compared against
 * anything. The answer this makes is one boolean.
 *
 * A missing or unreadable file answers no. An agent that cannot be found cannot
 * be promised.
 */
export function slackReachable(
  configPath = join(homedir(), ".claude.json"),
  credsPath = join(homedir(), ".claude", ".credentials.json"),
): boolean {
  try {
    // Synchronous by design: it is read on a route that decides whether to draw
    // a button, and the answer has to be there before the render.
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (namesSlack(cfg.mcpServers)) return true;
    for (const p of Object.values(cfg.projects ?? {})) if (namesSlack(p?.mcpServers)) return true;
  } catch { /* no hand-written config, or not readable — the OAuth store may
                still have it */ }
  return oauthedSlack(credsPath);
}

/**
 * The OAuth'd HTTP servers, which is where a Slack connected through the
 * browser actually lands.
 *
 * Keys are `<name>|<hash>`, so the name is taken from before the bar rather
 * than by matching the whole key — the hash is not ours to reason about. The
 * server URL is checked as a fallback for a connection somebody named something
 * else, by HOST and not by substring: a URL merely containing the word would be
 * a much weaker claim than the host being Slack's.
 */
function oauthedSlack(credsPath: string): boolean {
  try {
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
      mcpOAuth?: Record<string, { serverUrl?: string }>;
    };
    for (const [key, entry] of Object.entries(creds.mcpOAuth ?? {})) {
      if (/slack/i.test(key.split("|")[0] ?? "")) return true;
      const host = safeHost(entry?.serverUrl);
      if (host === "slack.com" || host.endsWith(".slack.com")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function safeHost(url: string | undefined): string {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; }
}

/** A server whose NAME says Slack. The name is what a person chose when they
 *  connected it, and it is the only part of the entry that is portable — the
 *  command, the transport and the arguments all differ per install. */
function namesSlack(servers: Record<string, unknown> | undefined): boolean {
  for (const name of Object.keys(servers ?? {})) if (/slack/i.test(name)) return true;
  return false;
}
