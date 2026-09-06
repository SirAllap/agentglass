/**
 * Validate destinations configured through the process environment.
 *
 * Loopback stays available for local integrations. Known service hosts are
 * accepted explicitly; every other remote destination needs the literal
 * AGENTGLASS_ALLOW_REMOTE=1 opt-in used by the hook scripts.
 *
 * The opt-in is one variable and the destinations are not one kind of thing,
 * so the trusted list is per caller rather than global. The webhook carries
 * notification text to a channel a person deliberately pasted a URL for, and
 * its two service hosts are named below. ANTHROPIC_BASE_URL carries repository
 * code, so it trusts Anthropic's own endpoint and nothing else.
 */
export type OutboundDestination =
  | { ok: true; url: string; host: string }
  | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The whole of 127.0.0.0/8 is this machine, not just .0.1 — a server bound to
 *  127.0.0.2 is as local as one on 127.0.0.1, and refusing it would be a guard
 *  disagreeing with the operating system about what "local" means. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The hosts the alert/nudge webhook exists for.
 *
 * AGENTGLASS_WEBHOOK is documented as "a Slack- or Discord-shaped incoming
 * webhook", so refusing exactly those two behind an opt-in would gate the
 * feature on its own purpose. `discordapp.com` is the older spelling Discord
 * still hands out and still accepts.
 */
export const WEBHOOK_SERVICE_HOSTS = ["hooks.slack.com", "discord.com", "discordapp.com"] as const;

export function outboundDestination(
  raw: string,
  label: string,
  trustedHosts: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): OutboundDestination {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `${label} is not a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `${label} must use http or https` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const trusted = LOOPBACK_HOSTS.has(hostname)
    || LOOPBACK_V4.test(hostname)
    || trustedHosts.some((host) => hostname === host.toLowerCase());
  if (!trusted && env.AGENTGLASS_ALLOW_REMOTE !== "1") {
    return {
      ok: false,
      error: `${label} points at remote host ${parsed.host}; set AGENTGLASS_ALLOW_REMOTE=1 to allow it`,
    };
  }
  return { ok: true, url: parsed.toString(), host: parsed.host };
}

export type WebhookDestination =
  | { configured: true; url: string; host: string }
  | { configured: false; error: string };

export function webhookDestination(
  env: Record<string, string | undefined> = process.env,
): WebhookDestination {
  const raw = env.AGENTGLASS_WEBHOOK;
  if (!raw) {
    return {
      configured: false,
      error: "no channel: set AGENTGLASS_WEBHOOK to a Slack- or Discord-compatible webhook",
    };
  }
  const destination = outboundDestination(raw, "AGENTGLASS_WEBHOOK", WEBHOOK_SERVICE_HOSTS, env);
  return destination.ok
    ? { configured: true, url: destination.url, host: destination.host }
    : { configured: false, error: destination.error };
}
