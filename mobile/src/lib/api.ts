/*
 * Talking to the computer.
 *
 * The same HTTP the dashboard uses, with the device credential as a bearer
 * token — no second protocol, no RPC layer, no schema to keep in step. The
 * shapes come from `shared/types.ts`, which the server compiles against, so a
 * field that changes on one side stops type-checking on the other.
 *
 * Two things differ from `web/src/lib/api.ts`, and both come from being an app
 * rather than a page:
 *
 *   * There is no origin to infer. A page can look at `location`; this asks
 *     the paired host record, and if there is none the answer is "not paired"
 *     rather than a request to a guess.
 *   * Every failure is a value, never a throw into a render. A phone loses the
 *     network constantly — walking out of the flat is not an error condition,
 *     it is Tuesday — so `ask()` answers `{ ok: false, error }` and the screens
 *     decide what that looks like.
 */
import type { Host } from "./host.ts";

export type Answer<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

/** Long enough for a git command on a cold repository, short enough that a
 *  dead wifi does not leave a spinner up for a minute. */
const TIMEOUT_MS = 15_000;

/*
 * Every shape "the computer is not there" arrives in, because there is more
 * than one and the list was one long.
 *
 * `Network request failed` is what React Native's own networking says, and it
 * was the only case handled. Hermes on Android also surfaces the JVM exception
 * verbatim — measured on an emulator with the sidecar down:
 *
 *   fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:4000
 *
 * which matched nothing here and went to the screen as-is, twice — once in the
 * Plan card and once in the status line above it. See `describeFailure`.
 */
const UNREACHABLE = /Network request failed|ConnectException|UnknownHostException|SocketTimeoutException|NoRouteToHostException|Unable to resolve host|Failed to connect|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|fetch failed/i;

/*
 * An address, in any spelling a networking error puts one in.
 *
 * Scrubbed from anything that reaches a caller, and this is the half that is
 * not tidiness. A phone talks to the machine over the LAN, so the address in a
 * connection error is the user's own network — `192.168.1.20:4000`, or a
 * tailnet name. A disconnected Home screen that prints it has put where the
 * machine lives into every screenshot of itself.
 *
 * Deliberately NOT "anything with a dot in it". That spelling ate `index.tsx`
 * and `shared/types.ts` out of messages that mentioned them, which turns a
 * useful failure into a vague one — so a bare dotted name is left alone unless
 * it carries a port, and the two host suffixes this app actually pairs over are
 * named outright.
 */
const ADDRESS = /\/?(?:\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?|\[[0-9a-f:]+\](?::\d{2,5})?|localhost(?::\d{2,5})?|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local)|[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5})/gi;

/** Exported for the tests. The failures this maps are unreachable machines and
 *  addresses, and neither can be produced from a unit test through `ask`. */
export function describeFailure(e: unknown): string {
  if (e instanceof Error && e.name === "AbortError") return "The computer did not answer in time";
  const raw = e instanceof Error ? e.message : String(e);
  if (UNREACHABLE.test(raw)) {
    // Which of "wrong address", "wifi off" and "nothing listening" it is, is
    // beyond what fetch reports — so this does not guess, and it does not hand
    // the exception to somebody holding a phone either.
    return "Cannot reach the computer";
  }
  /*
   * Anything else keeps its text, because an unrecognised failure that says
   * nothing is a failure nobody can act on — but it loses any address in it
   * first. A message this code did not anticipate is exactly the one most
   * likely to be carrying one.
   */
  return raw.replace(ADDRESS, "the computer");
}

/** Why a 401 here is worth its own sentence: the credential was revoked at the
 *  computer, and no amount of retrying fixes it — the phone has to pair again. */
export const REVOKED = "revoked";

export async function ask<T>(
  host: Host,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<Answer<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // The caller's own cancellation (a screen unmounting) and the deadline both
  // have to reach the same request.
  const onAbort = (): void => controller.abort();
  init?.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(host.origin + path, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${host.token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: REVOKED, status: response.status };
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: text || `The computer answered ${response.status}`, status: response.status };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch (e) {
    return { ok: false, error: describeFailure(e) };
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Start a turn, and do not wait for it to finish.
 *
 * `/chat/send` answers with NDJSON as the agent works, and React Native's fetch
 * cannot read a response body incrementally — it is XHR underneath, and `body`
 * is not a stream. So the phone does not try: it posts, checks that the turn
 * was ACCEPTED, and then reads the transcript back like everything else. The
 * conversation lives on the server, which is the property that makes this fine.
 *
 * The deadline is separate and long because a turn is not a request: fifteen
 * seconds is right for asking a question and absurd for an agent that is
 * editing files. What is being waited on here is only the server saying yes.
 */
export async function startTurn(
  host: Host,
  payload: { cwd: string; message: string; model: string; mode: string; resumeId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  // Long enough for a cold agent to spawn, short enough that a dead network
  // does not leave the composer disabled for ever.
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(host.origin + "/chat/send", {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // A refusal — chat disabled, out of scope, a directory that is not a repo —
    // comes back as plain text with a 4xx rather than as NDJSON. Read as text,
    // because parsing it as JSON is how a real explanation becomes silence.
    if (!response.ok) {
      const said = (await response.text().catch(() => "")).trim();
      return { ok: false, error: said.slice(0, 300) || `The computer answered ${response.status}` };
    }
    // The body is the turn itself and is deliberately left unread: the reply
    // will be in the transcript, and holding this open on a phone keeps a
    // socket alive through a screen lock for nothing.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFailure(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is anything at this address, and is it us?
 *
 * A 200 is not proof of identity. `:4000` is a popular default — Phoenix ships
 * on it, and so do several local observability servers — so a machine running
 * one of those hands the app a stranger, every request 404s, and the app looks
 * empty rather than misdirected. The dashboard learned this the hard way and
 * reads the body of `/health` rather than its status; so does this.
 *
 * Runs without a credential, because it is what the pairing screen calls
 * BEFORE there is one.
 */
export async function probe(origin: string, timeoutMs = 4000): Promise<"ours" | "foreign" | "down"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/health`, { signal: controller.signal });
    // A server that wants a token is still ours; we simply have not got one yet.
    if (response.status === 401 || response.status === 403) return "ours";
    if (!response.ok) return "foreign";
    const body = (await response.json()) as { service?: string; ok?: boolean; clients?: number };
    if (body.service === "agentglass") return "ours";
    // Accept the older shape too, so a computer running a build from before
    // `service` existed identifies as itself rather than as an impostor.
    return body.ok === true && typeof body.clients === "number" ? "ours" : "foreign";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
