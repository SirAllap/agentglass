/*
 * Pull-request watches and cards, from the live socket to a notification.
 *
 * The rules are the computer's: the phone hears the same `prwatchfire` and
 * `card` frames the desk does and decides only whether THIS phone draws one
 * (watchAlerts.ts). Nothing leaves the machines; the alert is local, so it is
 * drawn while the app is alive to hear the socket and not otherwise.
 *
 * "Read" is the computer's too, and nothing new was added for it: an alert the
 * desk closes arrives as `askedclosed` and takes the notification down here;
 * tapping one closes the computer's alert (when this phone may write); opening
 * the pull request moves its read mark, which the desk already shares.
 *
 * Every effect is a dependency, so the whole path runs under `bun test`.
 */
import type { AskedAlert } from "../../../shared/notifyPayload.ts";
import type { CardNote, PrWatchFire } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import type { HostEntry } from "../lib/hosts.ts";
import { readPhoneAlerts } from "./phoneAlertsPref.ts";
import { sinceStore, type SinceStore } from "./watchSince.ts";
import { validAlertId } from "./target.ts";
import {
  NO_CURSOR, advanceCursor, decideCatchUp, decideLive, itemFromAsked, itemFromCard, itemFromFire, markHandled, mergeCursor,
  type Cursor, type WatchContext, type WatchItem, type WatchRaise,
} from "./watchAlerts.ts";
import { SAME_ALERT_MS } from "./policy.ts";

export interface WatchDeps {
  /** Draw one. `decorate` names the computer when there are several. */
  raise: (r: WatchRaise, hostId: string, decorate: (title: string) => string) => Promise<{ ok: boolean }>;
  /** Take down whatever was drawn for a server alert of that computer. */
  dismissAlert: (alertId: string, hostId: string) => Promise<void>;
  /** Whether the person is looking at this computer in the app right now. */
  foreground: (host: HostEntry) => boolean;
  now: () => number;
  since: SinceStore;
  /** The computer's switch. Null when it could not be asked. */
  readEnabled: (host: HostEntry) => Promise<boolean | null>;
  ask: typeof ask;
}

/** What the app supplies; the rest default to the real thing. */
type Needed = Pick<WatchDeps, "raise" | "dismissAlert" | "foreground">;

export function createWatchAlerts(over: Needed & Partial<WatchDeps>) {
  const d: WatchDeps = { now: Date.now, since: sinceStore, readEnabled: readPhoneAlerts, ask, ...over };
  const handled = new Map<string, number>();
  /** The last answer per computer, kept for when it cannot be asked. */
  const enabledLast = new Map<string, boolean>();
  /** Per computer, how far it has been told (loaded by catchUp). */
  const cursors = new Map<string, Cursor>();
  /** Alerts heard live before the first catch-up of this run has loaded the cursor. */
  const ahead = new Map<string, Cursor>();
  /** Pull requests a comment watch or a talk note has just told about, so the two
   *  cannot buzz for one comment: whichever comes second stays quiet. */
  const told = new Map<string, number>();
  const toldKey = (by: "watch" | "talk", hostId: string, repo: string, number: number): string => `${by}\0${hostId}\0${repo}#${number}`;

  async function context(host: HostEntry): Promise<WatchContext> {
    const asked = await d.readEnabled(host);
    if (asked !== null) enabledLast.set(host.id, asked);
    return { enabled: asked ?? enabledLast.get(host.id) ?? true, foreground: d.foreground(host), handled, now: d.now() };
  }

  async function draw(host: HostEntry, raise: WatchRaise, decorate: (t: string) => string): Promise<boolean> {
    return (await d.raise(raise, host.id, decorate)).ok;
  }

  async function live(host: HostEntry, item: WatchItem | null, decorate: (t: string) => string, vetoed?: () => boolean): Promise<boolean> {
    if (!item) return false;
    const ctx = await context(host);
    // Something else told the person while the switch was being read.
    if (vetoed?.()) return false;
    const v = decideLive(item, ctx);
    // Told, whatever the verdict: a switch that is off or a screen that was open
    // still counts, so the catch-up after a reconnect does not repeat it.
    if (v.notify || v.because === "off" || v.because === "foreground") markHandled(handled, item.id, ctx.now);
    return v.notify ? draw(host, v.raise, decorate) : false;
  }

  return {
    /** A watch fired (`prwatchfire`). */
    onFire: async (host: HostEntry, fire: PrWatchFire, decorate: (t: string) => string): Promise<void> => {
      const comment = fire?.rule === "comment";
      const talked = (): boolean => comment && recently(told.get(toldKey("talk", host.id, fire.repo, fire.number)), d.now());
      if (talked()) return;
      /* A comment is claimed BEFORE the switch is read, so a talk note arriving while that request is out stays
         quiet; it is claimed only when the last answer said this phone draws it (a phone that is off, or looking
         at the app, claims nothing and leaves the talk note free), and given back if nothing was drawn. */
      const key = comment ? toldKey("watch", host.id, fire.repo, fire.number) : "";
      const claim = comment && enabledLast.get(host.id) !== false && !d.foreground(host);
      if (claim) told.set(key, d.now());
      const drawn = await live(host, itemFromFire(fire), decorate, talked);
      if (comment && !drawn) told.delete(key);
      else if (comment) told.set(key, d.now());
    },

    /** A card of yours moved (`card`). */
    onCard: async (host: HostEntry, card: CardNote, decorate: (t: string) => string): Promise<void> => { await live(host, itemFromCard(card), decorate); },

    /** The phone's own talk note raised a notification for this pull request. */
    noteTalk: (host: HostEntry, repo: string, number: number): void => { told.set(toldKey("talk", host.id, repo, number), d.now()); },
    /** A comment watch told about this pull request a moment ago. */
    watchToldRecently: (host: HostEntry, repo: string, number: number): boolean => recently(told.get(toldKey("watch", host.id, repo, number)), d.now()),

    /** An alert was raised on the computer (`askedalert`): the next reconnect starts after it. */
    async onAsked(host: HostEntry, alert: AskedAlert): Promise<void> {
      if (!validAlertId(alert?.id) || typeof alert.firedAt !== "number") return;
      const have = cursors.get(host.id);
      if (!have) { ahead.set(host.id, advanceCursor(ahead.get(host.id) ?? NO_CURSOR, alert.firedAt, alert.id)); return; }
      const next = advanceCursor(have, alert.firedAt, alert.id);
      if (next === have) return;
      cursors.set(host.id, next);
      await d.since.set(host.id, next);
    },

    /** The alert was closed on some device (`askedclosed`). */
    onClosed: (host: HostEntry, id: string): Promise<void> => (validAlertId(id) ? d.dismissAlert(id, host.id) : Promise.resolve()),

    /**
     * The socket came up. Read what the computer still holds open, and tell the
     * person what was missed as one notification at most. The first time ever on
     * a computer it only notes where things stand.
     */
    async catchUp(host: HostEntry, decorate: (t: string) => string): Promise<void> {
      const answer = await d.ask<{ ok: boolean; open?: AskedAlert[] }>(host, "/alerts/asked");
      if (!answer.ok || !Array.isArray(answer.value.open)) return;
      const items = answer.value.open.map(itemFromAsked);
      const stored = await d.since.get(host.id);
      const early = ahead.get(host.id) ?? NO_CURSOR;
      ahead.delete(host.id);
      if (stored === null) {
        const here = mergeCursor(items.reduce((c, i) => (i ? advanceCursor(c, i.at ?? 0, i.id) : c), NO_CURSOR), early);
        cursors.set(host.id, here);
        await d.since.set(host.id, here);
        return;
      }
      const from = mergeCursor(mergeCursor(stored, cursors.get(host.id) ?? NO_CURSOR), early);
      const ctx = await context(host);
      const r = decideCatchUp(items, from, ctx);
      for (const id of r.seen) markHandled(handled, id, ctx.now);
      cursors.set(host.id, r.cursor);
      await d.since.set(host.id, r.cursor);
      if (r.raise) await draw(host, r.raise, decorate);
    },
  };
}

const recently = (at: number | undefined, now: number): boolean => at !== undefined && now - at < SAME_ALERT_MS;

/**
 * Tapped: the computer's alert is answered, so the desk drops it too. Best
 * effort — a phone paired below full access is refused and nothing else changes.
 */
export async function answerWatch(host: Host, data: unknown, send: typeof ask = ask): Promise<void> {
  const id = (data as { alertId?: unknown } | null)?.alertId;
  if (!validAlertId(id)) return;
  await send(host, "/alerts/asked/close", { method: "POST", body: { id, acted: true } });
}
