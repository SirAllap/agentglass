/**
 * Validate destinations configured through the process environment.
 *
 * Loopback stays available for local integrations. Known service hosts are
 * accepted explicitly; every other remote destination needs the literal
 * AGENTGLASS_ALLOW_REMOTE=1 opt-in used by the hook scripts.
 */
export type OutboundDestination =
  | { ok: true; url: string; host: string }
  | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
  const destination = outboundDestination(raw, "AGENTGLASS_WEBHOOK", [], env);
  return destination.ok
    ? { configured: true, url: destination.url, host: destination.host }
    : { configured: false, error: destination.error };
}
