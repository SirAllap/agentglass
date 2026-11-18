import type { PublicPlugin } from "../../../shared/types.ts";
import { cardBand, versionChip, type CardBand } from "./pluginCard.ts";
import type { HeaderChip, PageNeed } from "./settingsNav.ts";

/** The tones a state word can take; the screen maps each to a badge colour.
 *  `err` is a plugin switched on with nothing running: the same red as its band. */
export type PluginStateTone = "ok" | "warn" | "err" | "off";

/** Running, off, or waiting on you: one word per plugin, chosen from the
 *  process (not the intent), because "on" while nothing runs is the failure
 *  this screen exists to show. */
export function pluginState(p: { enabled: boolean; running: boolean; approvedFingerprint: string | null; fingerprint: string; hadApproval: boolean }): [string, PluginStateTone] {
  const needsReview = p.approvedFingerprint !== p.fingerprint;
  if (needsReview && p.hadApproval) return ["Asks again", "warn"];
  if (needsReview && !p.enabled) return ["Not approved", "warn"];
  if (p.enabled && p.running) return ["Running", "ok"];
  if (p.enabled) return ["Enabled, not running", "err"];
  return ["Off", "off"];
}

/** Lower is shown first: what needs a person, then a failure, then an update,
 *  then what simply runs, then what is off. */
const RANK: Record<PluginKind, number> = { approval: 0, stopped: 1, update: 2, on: 3, off: 4 };

/** The one bin a plugin falls in: its band if it has one, else on or off.
 *  Every count on the page (header chips, tally, group labels, the Installed
 *  line, the nav mark) is a count of these bins, so no two of them disagree. */
export type PluginKind = Exclude<CardBand, null> | "on" | "off";

type Binned = Pick<PublicPlugin, "enabled" | "running" | "approvedFingerprint" | "fingerprint">;

export function pluginKind(p: Binned, hasUpdate: boolean): PluginKind {
  return cardBand(p, hasUpdate) ?? (p.enabled ? "on" : "off");
}

/** The installed list for any count, 0 or 40: attention first, then running,
 *  then off, each group by name. Never mutates its input. */
export function orderInstalled<T extends PublicPlugin>(plugins: readonly T[], hasUpdate: (p: T) => boolean): T[] {
  const rank = (p: T) => pluginKind(p, hasUpdate(p));
  return [...plugins].sort((a, b) => RANK[rank(a)] - RANK[rank(b)] || a.name.localeCompare(b.name));
}

/** One count per bin, plus what the page says out loud. Each plugin is in
 *  one bin: a running plugin with an update waiting is in `update` (it needs
 *  you), not in `on`. `needsYou` is exactly the "Needs you" group. `running`
 *  is every live process, whatever its bin, so "N running" never says fewer
 *  than run (the nav fact counts the same way). */
export interface PluginTally {
  total: number; on: number; off: number; approval: number; stopped: number; update: number;
  needsYou: number; running: number;
}

export function tallyInstalled<T extends Binned>(plugins: readonly T[], hasUpdate: (p: T) => boolean): PluginTally {
  const t: PluginTally = { total: plugins.length, on: 0, off: 0, approval: 0, stopped: 0, update: 0, needsYou: 0, running: 0 };
  for (const p of plugins) {
    t[pluginKind(p, hasUpdate(p))]++;
    if (p.enabled && p.running) t.running++;
  }
  t.needsYou = t.approval + t.stopped + t.update;
  return t;
}

export type PluginGroupId = "needs" | "running" | "off";
export interface PluginGroup<T> { id: PluginGroupId; label: string; items: T[] }

const GROUP_OF: Record<PluginKind, PluginGroupId> = { approval: "needs", stopped: "needs", update: "needs", on: "running", off: "off" };
const GROUP_LABEL: Record<PluginGroupId, string> = { needs: "Needs you", running: "Running", off: "Off" };

/** The installed list cut into "Needs you", "Running" and "Off", in that
 *  order and in orderInstalled's order inside each; an empty group is left out. */
export function groupInstalled<T extends PublicPlugin>(plugins: readonly T[], hasUpdate: (p: T) => boolean): PluginGroup<T>[] {
  const out: PluginGroup<T>[] = (["needs", "running", "off"] as const).map((id) => ({ id, label: GROUP_LABEL[id], items: [] }));
  for (const p of orderInstalled(plugins, hasUpdate)) out.find((g) => g.id === GROUP_OF[pluginKind(p, hasUpdate(p))])!.items.push(p);
  return out.filter((g) => g.items.length > 0);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The chips beside the page title. Running is said whenever anything is
 *  installed; the rest only when not zero. Approval + stopped + update add up
 *  to the "Needs you" group, so the header and the list say the same number. */
export function pluginHeadChips(t: PluginTally): HeaderChip[] {
  if (!t.total) return [];
  const out: HeaderChip[] = [{ tone: "ok", text: `${t.running} running` }];
  if (t.approval) out.push({ tone: "warn", text: `${plural(t.approval, "needs", "need")} approval` });
  if (t.stopped) out.push({ tone: "err", text: `${t.stopped} stopped` });
  if (t.update) out.push({ tone: "info", text: plural(t.update, "update", "updates") });
  return out;
}

/** The status card's headline and the colour of its dot: the worst thing wins. */
export function systemHeadline(t: PluginTally): { text: string; tone: "ok" | "warn" | "err" | "off" } {
  if (!t.total) return { text: "Nothing installed yet", tone: "off" };
  if (t.needsYou) return { text: `${plural(t.needsYou, "plugin needs", "plugins need")} you`, tone: t.stopped ? "err" : "warn" };
  return { text: `${t.running} of ${t.total} running`, tone: "ok" };
}

/** What the nav mark says: the Needs-you count, worst first in its sentence. */
export function pluginNavNeed(t: PluginTally): PageNeed | null {
  if (!t.needsYou) return null;
  const title = [
    t.stopped ? `${t.stopped} stopped` : "",
    t.approval ? `${plural(t.approval, "needs", "need")} approval` : "",
    t.update ? plural(t.update, "update", "updates") : "",
  ].filter(Boolean).join(" · ");
  return { count: t.needsYou, title };
}

/** The Plugins page's latest tally, kept after the page closes so the nav
 *  mark goes on reading the same tally (updates included) instead of falling
 *  back to an approval-only count. Settings clears it on each open, when it
 *  reads the list afresh; `null` means the page has not reported since. */
let lastTally: PluginTally | null = null;
const tallySubs = new Set<() => void>();
export const pluginTallyStore = {
  get: (): PluginTally | null => lastTally,
  set(t: PluginTally | null): void {
    if (t === lastTally || (t && lastTally && (Object.keys(t) as (keyof PluginTally)[]).every((k) => t[k] === lastTally![k]))) return;
    lastTally = t;
    for (const f of tallySubs) f();
  },
  subscribe(f: () => void): () => void { tallySubs.add(f); return () => { tallySubs.delete(f); }; },
};

/** The one quiet line under a plugin's name in the list: who, which version, and what is waiting. */
export function compactLine(p: Pick<PublicPlugin, "publisher" | "resolvedCommit" | "source">, hasUpdate: boolean): string {
  return [`by ${p.publisher}`, versionChip(p), hasUpdate ? "update available" : ""].filter(Boolean).join(" · ");
}
