/*
 * The Inbox's data, and what it costs.
 *
 * ── the pull requests are free ────────────────────────────────────────────
 * The store already fetches them: `loadPrs` in host-context.tsx asks `mine`
 * and `review` across up to six main checkouts and tags each row with which
 * filter produced it. That is exactly this screen's pull-request data, so it
 * is read out of `fleet` rather than fetched again. A second copy would double
 * the GitHub traffic to answer a question already on the device.
 *
 * ── the issues and the cards are not ──────────────────────────────────────
 * Nothing else on the phone asks for either. Issues cost one request per
 * repository (`assignee=@me`, which gh resolves, so the phone never has to
 * know who you are); cards cost exactly one, because a board is not per
 * checkout.
 *
 * The repository cap is the same six the store uses, and for the same reason:
 * a machine with twenty-three checkouts would otherwise open twenty-three
 * conversations with GitHub every time somebody looked at their phone. Beyond
 * six the screen says so rather than pretending it looked everywhere.
 *
 * ── what has been looked at ───────────────────────────────────────────────
 * `seen` is a map of id → when it was last opened, kept in the keystore. It is
 * what makes "moved since you looked" a claim rather than a guess, and it is
 * the only state this app keeps about your reading rather than the machine's.
 * Read once on mount; written when a row is opened.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitRepoRef, IssuesReport } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import { mainCheckouts } from "../model/prRows.ts";
import { buildInbox, inboxCounts, remember, type InboxIssue, type InboxItem } from "../model/inbox.ts";
import { readSeen, writeSeen } from "../lib/seen.ts";
import { useAgentglass } from "./host-context.tsx";

/** The same six the store's own pull-request pass uses. Named here rather than
 *  imported so the two can be argued about separately — this screen could
 *  afford a different number, it simply does not need one. */
const REPO_CAP = 6;

export interface Inbox {
  items: InboxItem[];
  counts: { needs: number; failing: number; ready: number };
  /** False until the slower half — issues and cards — has answered once. The
   *  screen uses it to avoid drawing "nothing needs you" over a list that has
   *  not arrived, which is the difference between good news and no news. */
  loaded: boolean;
  /** How many repositories were left unasked, so the screen can say so. */
  skipped: number;
  reload: () => void;
  /** Mark a row as read, at the moment it moved. Takes the item rather than an
   *  id so a caller cannot store the wrong timestamp against the right key. */
  markSeen: (item: InboxItem) => void;
}

export function useInbox(): Inbox {
  const { host, fleet } = useAgentglass();
  const [issues, setIssues] = useState<InboxIssue[]>([]);
  const [cards, setCards] = useState<ProviderTask[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => { void readSeen().then(setSeen); }, []);

  useEffect(() => {
    if (!host) return;
    let gone = false;
    void (async () => {
      const repos = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (gone) return;
      const all = repos.ok && Array.isArray(repos.value.repos)
        ? mainCheckouts(repos.value.repos)
        : [];
      const roots = all.slice(0, REPO_CAP);
      if (!gone) setSkipped(Math.max(0, all.length - roots.length));

      const found = await Promise.all(roots.map(async (repo) => {
        const query = `root=${encodeURIComponent(repo.root)}&assignee=%40me&state=open`;
        const answer = await ask<IssuesReport>(host, `/issues/list?${query}`);
        // A repository without a GitHub remote, or one gh cannot reach, answers
        // an error. That is one repository's worth of nothing, not a reason to
        // empty the whole screen.
        if (!answer.ok || !answer.value.ok) return [];
        return (answer.value.issues ?? []).map((issue) => ({ root: repo.root, issue }));
      }));
      if (gone) return;
      setIssues(found.flat());

      // The board the phone is already showing, so the Inbox and the Cards tab
      // cannot disagree about which cards exist.
      const views = await ask<{ current?: string; views?: { id: string }[] }>(host, "/clickup/views");
      const view = views.ok ? views.value.current ?? views.value.views?.[0]?.id ?? "" : "";
      if (view) {
        const answer = await ask<{ tasks: ProviderTask[] }>(
          host, `/clickup/view?id=${encodeURIComponent(view)}`,
        );
        if (!gone && answer.ok) setCards(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
      }
      if (!gone) setLoaded(true);
    })();
    return () => { gone = true; };
  }, [host, tick]);

  const items = useMemo(() => buildInbox({
    prs: fleet.prs,
    issues,
    cards,
    seen,
    // Pinned to the last load rather than to render time, the same rule
    // use-queue.ts states: a row must not change group because the list
    // repainted.
    now: fleet.at || Date.now(),
  }), [fleet.prs, fleet.at, issues, cards, seen]);

  const markSeen = useCallback((item: InboxItem): void => {
    setSeen((was) => {
      const next = remember(was, item.id, item.at || Date.now());
      // Fire and forget: a keystore write that loses a race costs one row
      // reappearing in "moved", and blocking a tap on it would be the worse
      // trade.
      void writeSeen(next);
      return next;
    });
  }, []);

  return {
    items,
    counts: useMemo(() => inboxCounts(items), [items]),
    loaded,
    skipped,
    reload: useCallback(() => setTick((n) => n + 1), []),
    markSeen,
  };
}
