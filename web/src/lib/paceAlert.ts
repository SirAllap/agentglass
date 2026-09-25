import type { PaceAlert, ProviderUsage } from "../../../shared/types.ts";
import { budgetLine, whenLabel } from "../../../shared/pace.ts";
import { fireDesktopAlert } from "./sysNotify.ts";
import { notifies } from "../../../shared/notifyPrefs.ts";
import { getNotifyPrefs } from "./notifyPrefsStore.ts";
import { paceConfig } from "./paceConfig.ts";
import { api } from "./api.ts";
import { PACE_MIN_MINUTES, windowPace } from "./usagePace.ts";

/**
 * One notification per long window, when it reaches the alert level.
 *
 * The DECISION is the server's (server/src/paceAlert.ts): once per window for
 * every client together, remembered on disk. This file asks it, after each
 * reading, and words what comes back in this person's working hours.
 *
 * It rides the existing Usage kind, so it is off until the person turns that
 * kind on, and it goes to the channels they picked. It is urgency 1: a row in
 * the bell and a popup that closes itself, never a sticky one and never the
 * interruption reserved for an agent blocked on a person.
 */

/** Ask whether any long window has newly reached the level. */
export function checkPaceAlerts(rows: ProviderUsage[]): void {
  const prefs = getNotifyPrefs();
  if (!notifies(prefs, "usage", "bell") && !notifies(prefs, "usage", "desktop")) return;
  if (!rows.some((u) => u.available && u.windows.some((w) => w.minutes >= PACE_MIN_MINUTES))) return;
  void api.claimPaceAlerts(paceConfig().alertAt).catch(() => { /* the next read asks again */ });
}

/** Word one alert the server raised. */
export function showPaceAlert(a: PaceAlert, now = Date.now()): void {
  const cfg = paceConfig();
  const wp = windowPace(a.provider, { label: a.label, minutes: a.minutes, usedPercent: a.usedPercent, resetsAt: new Date(a.resetsAt).toISOString() }, now, cfg);
  fireDesktopAlert({
    title: `${a.providerLabel} ${a.label}: ${a.usedPercent}% used`,
    body: `Past your ${a.alertAt}% line, resets ${whenLabel(a.resetsAt, now, cfg.timeZone)}.${wp ? ` ${budgetLine(wp.pace)}.` : ""}`,
    urgency: 1, key: `pace:${a.provider}|${a.label}`, notifyKind: "usage",
  });
}
