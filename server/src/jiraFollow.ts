/*
 * Watching a Jira card and voting for it, written from the pane or the door.
 *
 * Each is the connected account's own mark on the card (shared/jiraFollow.ts), so there is no card stamp to check: the
 * card's `updated` does not move and nobody else's view of it changes. Both are idempotent on the site. A toggle is one
 * request and has no read-back; the pane moves the count it already holds. Both are behind the Jira write switch, like
 * every other change that leaves the app.
 *
 * Watching names the account in the request. Cloud takes the account id as a bare JSON string and removes by
 * `?accountId=`; Data Center takes the login the same way and removes by `?username=`. The login is not what the
 * connection stores (that is the key, which a modern site makes something opaque), so Data Center asks `myself` once
 * and remembers the answer for the connection: its first watch is two requests, its later ones one.
 *
 * Voting names nobody: the site knows who is asking. It is refused for the account's own cards and where the site has
 * voting off, and the site does not say which, so the sentence offers both.
 *
 * Ceiling: the site's own words never reach the answer, only ours, and a 404 on a vote is not told apart from "voting is
 * off" (measured on no real site yet; the fake and the documented API only).
 */
import { redacted } from "./credentials.ts";
import { ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, jiraCall, jiraWriteEnabled, storedCreds, type JiraCreds, type JiraResult } from "./jira.ts";
import type { FollowKind } from "../../shared/jiraFollow.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

/** `on` is the mark as it now is; `denied` says the site refused this account, so a pane stops offering it. */
export type FollowOutcome = WriteOutcome & { on?: boolean; denied?: boolean };

const no = (error: string): FollowOutcome => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Data Center's login for the connection, asked once: the stored id is its key, and a watcher is named by login. */
let login: { site: string; token: string; name: string } | null = null;
export function __forgetLogin(): void { login = null; }

/** The id a watcher is named by on this site, or the sentence that says it could not be found. */
async function watcherId(creds: JiraCreds): Promise<{ id: string } | { stop: FollowOutcome }> {
  if (apiOf(creds) === 3) {
    const id = redacted("jira")?.accountId ?? "";
    return id ? { id } : { stop: no("Nothing was changed: could not tell which account is connected") };
  }
  if (login && login.site === creds.site && login.token === creds.token) return { id: login.name };
  const r = await jiraCall<unknown>(creds, "/rest/api/2/myself", { fresh: true });
  const name = r.ok && isObj(r.data) && typeof r.data.name === "string" ? r.data.name : "";
  if (!name) return { stop: { ok: false, unauthorised: r.unauthorised, error: r.ok ? "Nothing was changed: could not tell which account is connected" : `Nothing was changed: ${r.error ?? "Jira did not answer"}` } };
  login = { site: creds.site, token: creds.token, name };
  return { id: name };
}

/** Why the site refused, in our words: its own text never reaches the answer. */
function refusal(r: JiraResult<unknown>, kind: FollowKind, upper: string): FollowOutcome {
  if (r.status === 403) return { ...no(`Your Jira account cannot ${kind === "watch" ? "watch" : "vote for"} ${upper}`), denied: true };
  if (r.status === 404 || r.status === 400) {
    return no(kind === "watch" ? `Jira could not find ${upper}: reload the card` : `Jira would not take that vote: voting may be off on this site, or ${upper} may be your own card`);
  }
  return { ok: false, unauthorised: r.unauthorised, error: r.error ?? "Jira did not accept that" };
}

/** Watch a card or stop watching it. `on` must be a boolean: the text "false" is not a way to say no. */
export async function setWatch(creds: JiraCreds, key: string, on: unknown): Promise<FollowOutcome> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  if (!ISSUE_KEY.test(key)) return no("That is not a Jira card id");
  if (typeof on !== "boolean") return no("Say whether to watch the card: on is true or false");
  const who = await watcherId(creds);
  if ("stop" in who) return who.stop;
  const upper = key.toUpperCase();
  const base = `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/watchers`;
  const r = on
    ? await jiraCall<unknown>(creds, base, { method: "POST", body: who.id })
    : await jiraCall<unknown>(creds, `${base}?${apiOf(creds) === 3 ? "accountId" : "username"}=${encodeURIComponent(who.id)}`, { method: "DELETE" });
  return r.ok ? { ok: true, on } : refusal(r, "watch", upper);
}

/** Vote for a card or take the vote back. */
export async function setVote(creds: JiraCreds, key: string, on: unknown): Promise<FollowOutcome> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  if (!ISSUE_KEY.test(key)) return no("That is not a Jira card id");
  if (typeof on !== "boolean") return no("Say whether to vote: on is true or false");
  const upper = key.toUpperCase();
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/votes`, { method: on ? "POST" : "DELETE" });
  return r.ok ? { ok: true, on } : refusal(r, "vote", upper);
}

const stored = async (run: (c: JiraCreds) => Promise<FollowOutcome>): Promise<FollowOutcome> => {
  const c = storedCreds();
  return c ? run(c) : no(NOT_CONNECTED);
};
export const setWatchStored = (key: string, on: unknown): Promise<FollowOutcome> => stored((c) => setWatch(c, key, on));
export const setVoteStored = (key: string, on: unknown): Promise<FollowOutcome> => stored((c) => setVote(c, key, on));
