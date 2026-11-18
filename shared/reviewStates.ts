// Who reviewed a pull request and in what state, split into people and bots,
// for the board's "Human reviewer", "Human review" and "Bot review" rule fields.
//
// Built from what the list's second pass already reads (the reviews and the
// requested reviewers), so it costs no request. GitHub counts a bot's approval
// in `reviewDecision`; these fields exist so a rule can tell the two apart.
import { isBotLogin } from "./botLogin.ts";
import type { ReviewStates } from "./types.ts";

type Node = { state?: string; author?: { login?: string; __typename?: string } | null };

/**
 * Latest standing state per login. Same reading as `humanVerdict`: an approval
 * or a change request stands until that person dismisses it or says the other;
 * a comment never outranks them. The author is not a reviewer. A team has no
 * face and is not a person, so it is not listed. A person who was asked and has
 * no verdict is `pending`, which outranks a bare comment, because the pull
 * request is still waiting on them. A re-request beats an older verdict (the
 * request is the newer fact), and a dismissed review counts as no review. A
 * bot is the actor GraphQL types `Bot`; the login list is only the fallback
 * for a login with no type (a requested reviewer).
 */
export function reviewStatesOf(
  nodes: unknown,
  o: { author?: string; pending?: string[]; teams?: string[] } = {},
): ReviewStates {
  const rows = Array.isArray(nodes) ? (nodes as Node[]) : [];
  const author = (o.author || "").toLowerCase();
  const strong = new Map<string, { login: string; state: "approved" | "changes" }>();
  const spoke = new Map<string, string>();
  const typed = new Set<string>();
  for (const r of rows) {
    const login = r?.author?.login || "";
    if (!login || r.state === "PENDING") continue;
    const k = login.toLowerCase();
    if (r.state === "DISMISSED") {
      strong.delete(k);
      spoke.delete(k);
      continue;
    }
    spoke.set(k, login);
    if (r.author?.__typename === "Bot") typed.add(k);
    if (r.state === "APPROVED") strong.set(k, { login, state: "approved" });
    else if (r.state === "CHANGES_REQUESTED") strong.set(k, { login, state: "changes" });
  }

  const teams = new Set((o.teams ?? []).map((t) => t.toLowerCase()));
  const asked = new Map<string, string>();
  for (const l of o.pending ?? []) {
    if (l && !teams.has(l.toLowerCase())) asked.set(l.toLowerCase(), l);
  }

  const isBot = (k: string, login: string) => typed.has(k) || isBotLogin(login);
  const humans: ReviewStates["humans"] = [];
  const bots: ReviewStates["bots"] = [];
  const humanKeys = new Set<string>([...asked.keys(), ...spoke.keys()]);
  for (const k of humanKeys) {
    const login = asked.get(k) ?? spoke.get(k)!;
    if (isBot(k, login) || k === author) continue;
    const s = strong.get(k);
    humans.push({ login, state: asked.has(k) ? "pending" : s ? s.state : "comment" });
  }
  for (const k of humanKeys) {
    const login = asked.get(k) ?? spoke.get(k)!;
    if (!isBot(k, login) || k === author) continue;
    const s = strong.get(k);
    bots.push({ login, state: asked.has(k) ? "pending" : s ? s.state : "comment" });
  }
  return { humans, bots };
}

/** "Human reviewer": a person is requested or has reviewed. `null` while the
 *  second pass has not said, so a rule neither hides nor shows the row on a guess. */
export function humanReviewerTokens(s: ReviewStates | undefined): string[] | null {
  return s ? [s.humans.length ? "assigned" : "unassigned"] : null;
}

const WORD = { approved: "approved", changes: "changes-requested", comment: "commented", pending: "pending" } as const;

/** "Human review": every state a person is in; `none` when no person reviewed
 *  (a request alone is `pending`, not a review). */
export function humanReviewTokens(s: ReviewStates | undefined): string[] | null {
  if (!s) return null;
  const out = [...new Set(s.humans.map((h) => WORD[h.state]))];
  return out.length ? out : ["none"];
}

/** "Bot review": every state a bot is in; `none` when no bot reviewed. */
export function botReviewTokens(s: ReviewStates | undefined): string[] | null {
  if (!s) return null;
  const out = [...new Set(s.bots.map((b) => WORD[b.state]))];
  return out.length ? out : ["none"];
}
