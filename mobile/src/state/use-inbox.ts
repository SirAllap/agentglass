/*
 * The Inbox's fan-out, shared by the bell and the screen.
 *
 * The bell is in the header of every destination and the list is one screen,
 * and they must show the same number: a bell that counts four over a list of
 * three is the failure this file exists to make impossible. So both read one
 * module-level snapshot, refreshed on the same clock, rather than each asking
 * the computer and hoping the answers land in the same second.
 *
 * ── what is asked, and what is not ───────────────────────────────────────
 * Four routes are asked here: `/settings/requests`, `/agents/board`,
 * `/flight-plan/plans` and `/prs/notify-watch/pending`. The gates and the review
 * requests are NOT asked again:
 * the host context already holds both for every screen (a 20 s pass and a 3 min
 * pass), and a second copy on a second clock is a second answer. That is also
 * why answering a gate moves the number without this file doing anything.
 *
 * ── a failed route keeps the others ─────────────────────────────────────
 * `Promise.allSettled`, and the failure becomes one sentence in `missing`
 * (model/inbox.ts names the source). A route that did not answer never empties
 * the list or the badge.
 *
 * ── why a minute ────────────────────────────────────────────────────────
 * The bell is mounted on every screen, so this must not be a request per
 * navigation. Sixty seconds is the same order as the host context's own poll
 * and shorter than a person notices a settings request go unanswered; an
 * answer given in the Inbox calls `reload`, so the common case is instant.
 */
import { useEffect, useMemo, useState } from "react";
import type { SettingRequestView } from "../../../shared/settingClass.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import {
  collectInbox, type InboxFailure, type PlanWaiting, type ReviewWaiting, type StoppedAgent, type InboxView,
  type WatchWaiting,
} from "../model/inbox.ts";
import { nextExpiryIn, refreshesInbox } from "../model/inboxStale.ts";
import type { WsFrame } from "../../../shared/types.ts";
import type { Fleet } from "./host-context.tsx";

const HEARD_MS = 60_000;

interface Snapshot {
  origin: string;
  at: number;
  settings: SettingRequestView[];
  agents: StoppedAgent[];
  plans: PlanWaiting[];
  /** Watches that fired while no client was listening. Acknowledging one is a
   *  write, so they stay here until a phone that may write clears them. */
  fires: WatchWaiting[];
  failed: InboxFailure[];
}

let held: Snapshot | null = null;
/** One read at a time PER COMPUTER: re-pairing while a read is out must not
 *  make the new machine wait on the old one's answer. */
let inflight: { origin: string; done: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  held = next;
  for (const l of listeners) l();
}

async function readInbox(host: Host): Promise<void> {
  if (inflight?.origin === host.origin) return inflight.done;
  const done = (async () => {
    const failed: InboxFailure[] = [];
    const want = async <T,>(
      path: string, key: "requests" | "agents" | "plans" | "fires", source: InboxFailure["source"],
    ): Promise<T[]> => {
      const answer = await ask<Record<string, unknown>>(host, path);
      if (!answer.ok) { failed.push({ source, error: answer.error }); return []; }
      const value = answer.value;
      // A 200 that carries the failure: the read did not happen.
      if (!value || value.ok === false) {
        failed.push({
          source,
          error: typeof value?.error === "string" ? value.error : "The request was refused.",
        });
        return [];
      }
      const got = value[key];
      if (!Array.isArray(got)) {
        failed.push({ source, error: "The answer had no list in it." });
        return [];
      }
      return got as T[];
    };
    const [settings, agents, plans, fires] = await Promise.all([
      want<SettingRequestView>("/settings/requests", "requests", "settings"),
      want<StoppedAgent>("/agents/board", "agents", "agents"),
      want<PlanWaiting>("/flight-plan/plans", "plans", "plans"),
      want<WatchWaiting>("/prs/notify-watch/pending", "fires", "watches"),
    ]);
    publish({ origin: host.origin, at: Date.now(), settings, agents, plans, fires, failed });
  })().finally(() => { if (inflight?.done === done) inflight = null; });
  inflight = { origin: host.origin, done };
  return done;
}

/** A frame from `/stream`. The server pushes one whenever a settings request
 *  or a flight plan changes — answered at the desk, expired, new — so the list
 *  reads again now rather than at the next minute. See model/inboxStale.ts. */
export function inboxHeard(host: Host, frame: Pick<WsFrame, "type">): void {
  if (refreshesInbox(frame)) void readInbox(host);
}

/**
 * The Inbox as this phone sees it, and the same list the bell counts.
 *
 * `reviews` are the fleet's own `review` rows with the viewer's own pull
 * requests removed — the same filter the old tab badge used, kept here so the
 * number and the list cannot drift.
 */
export interface InboxUse extends InboxView {
  loading: boolean;
  reload: () => void;
  /** The rows behind the plan cards and the agents roster, so a card draws the
   *  launch line from the same read that produced its row. */
  plans: PlanWaiting[];
  agents: StoppedAgent[];
  /** A fire the person has read. The route is a POST, so a phone paired to look
   *  only cannot clear one — the queue keeps it until a full phone or the desk
   *  acknowledges it, rather than the row disappearing from under an answer
   *  that never happened. */
  ack: (seq: number) => void;
}

export function useInbox(host: Host | null, fleet: Fleet): InboxUse {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = (): void => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (!host) return;
    const fresh = held?.origin === host.origin && Date.now() - held.at < HEARD_MS;
    if (!fresh) void readInbox(host);
  }, [host, host?.origin, fleet.at]);

  const snap = host && held?.origin === host.origin ? held : null;

  /* A settings request the server declines at `expires` leaves the list at
     `expires`: one timer to the soonest, and the list is drawn again then. */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const wait = nextExpiryIn(snap?.settings ?? [], clock);
    if (wait === null) return;
    const t = setTimeout(() => setClock(Date.now()), wait + 50);
    return () => clearTimeout(t);
  }, [snap, clock]);
  const reviews = useMemo<ReviewWaiting[]>(
    () => fleet.prs
      .filter((r) => r.scope === "review" && r.pr.author !== fleet.me)
      .map((r) => ({ root: r.root, repo: r.repo, pr: r.pr })),
    [fleet.prs, fleet.me],
  );
  const view = useMemo(
    () => collectInbox({
      gates: fleet.gates,
      reviews,
      settings: snap?.settings ?? null,
      agents: snap?.agents ?? null,
      plans: snap?.plans ?? null,
      watches: snap?.fires ?? null,
      failed: snap?.failed ?? [],
    }, host?.scope, Math.max(clock, Date.now())),
    [fleet.gates, reviews, snap, host?.scope, clock],
  );

  /* The row's own fire leaves the list on the press, not on the computer's
     answer: it is already open on screen and a row that stayed behind its own
     tap reads as a buzz that did not register. An answer the computer did not
     take puts the row back and reads again, so the bell is not short by one
     until the next minute's read. */
  const ack = (seq: number): void => {
    if (!host || host.scope !== "full") return;
    const fire = held?.origin === host.origin ? held.fires.find((f) => f.seq === seq) : undefined;
    if (held?.origin === host.origin) {
      publish({ ...held, fires: held.fires.filter((f) => f.seq !== seq) });
    }
    void ask<{ ok?: boolean; error?: string }>(host, "/prs/notify-watch/ack", { method: "POST", body: { seq } })
      .then((answer) => {
        if (answer.ok && answer.value.ok !== false) return;
        if (fire && held?.origin === host.origin) publish({ ...held, fires: [...held.fires, fire] });
        // A refusal the computer wrote is worth reading again; a route that did
        // not answer is not — that read would fail too, and a failed route
        // empties the fires it never asked about.
        if (answer.ok) void readInbox(host);
      });
  };

  return {
    ...view,
    loading: !snap,
    reload: () => { if (host) void readInbox(host); },
    plans: snap?.plans ?? [],
    agents: snap?.agents ?? [],
    ack,
  };
}
