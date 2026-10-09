/*
 * Who can be put on a card of a list, read once and shared.
 *
 * Seven places asked for the same thing on their own: the card's Assigned select in Tasks, the one in the
 * pull request's rail, the review menu, the merge dialog, the hand-off button, and the two lists a step
 * asks when it runs. Each held its own copy and each opened its own request, so a card and its pull
 * request read the same people twice. The server holds the answer too (it is cached there), so this is
 * not about saving ClickUp requests; it is one answer for one list on one page, with the people appearing
 * at once the second time a picker is opened.
 *
 * Held a minute per list, in flight once however many ask, and a failure is NOT kept: a server down for a
 * moment must not leave every picker empty for the next minute. It is the shape `api.clickupMembers`
 * answers in, so a caller changes only which function it calls.
 */
import { api } from "./api.ts";
import type { ListMember } from "../../../shared/providers.ts";

type Answer = { ok: boolean; error?: string; members?: ListMember[] };

const TTL = 60_000;
const held = new Map<string, { at: number; value: Answer }>();
const inflight = new Map<string, Promise<Answer>>();

/** The members of a list, from this page's copy when it is a minute old or less. */
export function listMembers(listId: string): Promise<Answer> {
  const hit = held.get(listId);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value);
  const pending = inflight.get(listId);
  if (pending) return pending;
  const p = api.clickupMembers(listId)
    .then((r) => {
      if (r?.ok) held.set(listId, { at: Date.now(), value: r });
      return r;
    })
    .finally(() => { inflight.delete(listId); });
  inflight.set(listId, p);
  return p;
}

/** For the moment the credential changes: what was read under the old one goes. */
export function __forgetListMembers(): void { held.clear(); inflight.clear(); }
