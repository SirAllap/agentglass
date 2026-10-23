/*
 * Watching and voting on a Jira card from its pane: the one request in flight, the sentence said after it, and a refusal
 * of the account itself remembered for the card.
 *
 * One at a time for the two together: both are the account's own mark and idempotent, so the guard is not about stamps
 * but about a count that moves by one for each answer, which two answers in a row would move out of order. A refusal that
 * is the account's (the site said 403) stops the control being offered again on this card; one that is only this press
 * (a vote on a card of one's own, a card that is gone) says so and leaves the control as it was. The counts the pane
 * shows after a press are the ones it already had, moved by one (shared/jiraFollow.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { followAfter, followSaid, type CardFollow, type FollowKind } from "../../../../shared/jiraFollow.ts";

export interface JiraFollowUi {
  follow: CardFollow | undefined;
  busy: FollowKind | null;
  /** What the last press said, "!" first when it did not go through. */
  said: string;
  denied: Partial<Record<FollowKind, string>>;
  press: (kind: FollowKind, on: boolean) => void;
}

export function useJiraFollow(o: {
  cardKey: string;
  follow: CardFollow | undefined;
  /** The marks and counts as a press left them. */
  onFollow: (f: CardFollow) => void;
}): JiraFollowUi {
  const [busy, setBusy] = useState<FollowKind | null>(null);
  const [said, setSaid] = useState("");
  const [denied, setDenied] = useState<Partial<Record<FollowKind, string>>>({});
  const keyRef = useRef(o.cardKey);
  keyRef.current = o.cardKey;
  const cb = useRef(o);
  cb.current = o;
  const going = useRef(false);

  // What was said, and what the site refused, belong to the card they were about.
  useEffect(() => { setBusy(null); setSaid(""); setDenied({}); going.current = false; }, [o.cardKey]);

  const press = useCallback((kind: FollowKind, on: boolean) => {
    const was = cb.current.follow;
    if (going.current || !was) return;
    going.current = true;
    const forKey = keyRef.current;
    setBusy(kind); setSaid("");
    void (kind === "watch" ? api.jiraWatch(forKey, on) : api.jiraVote(forKey, on))
      .catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraWatch>>))
      .then((r) => {
        if (forKey !== keyRef.current) return;
        going.current = false;
        setBusy(null);
        if (!r.ok) {
          setSaid(`!${r.error || "Jira refused that"}`);
          if (r.denied) setDenied((d) => ({ ...d, [kind]: r.error || "Your Jira account cannot do that here" }));
          return;
        }
        cb.current.onFollow(followAfter(cb.current.follow ?? was, kind, on));
        setSaid(followSaid(kind, on, forKey));
      });
  }, []);

  return { follow: o.follow, busy, said, denied, press };
}
