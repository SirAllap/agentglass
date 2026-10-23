import type { PublicPlugin } from "../../../shared/types.ts";
import { describeSandbox } from "../../../shared/pluginSandbox.ts";

/** Every control on a plugin card, the dialogs that ask about it and the
 *  page's own bar: one height, so a footer of buttons reads as one row. */
export const PLUGIN_CTRL_H = 30;

/**
 * What a card says first, in priority order: a decision the person has to
 * make beats a failure, and a failure beats an update that can wait.
 *
 *   approval  never approved, or asking again: the switch cannot be trusted
 *             until they read it
 *   stopped   switched on and nothing runs
 *   update    the market lists something other than what is installed
 */
export type CardBand = "approval" | "stopped" | "update" | null;

export function cardBand(p: { enabled: boolean; running: boolean; approvedFingerprint: string | null; fingerprint: string }, hasUpdate: boolean): CardBand {
  if (p.approvedFingerprint !== p.fingerprint) return "approval";
  if (p.enabled && !p.running) return "stopped";
  return hasUpdate ? "update" : null;
}

/** The one filled button. `null` when a card has nothing to lead with, so a
 *  card never shows two filled buttons. */
export type PrimaryAction = "review" | "update" | "open" | "settings" | null;

export function primaryAction(band: CardBand, p: { enabled: boolean; hasPanel: boolean; hasSettings: boolean }): PrimaryAction {
  if (band === "approval") return "review";
  if (band === "stopped") return p.hasSettings ? "settings" : null;
  if (band === "update") return "update";
  if (p.enabled && p.hasPanel) return "open";
  return p.hasSettings ? "settings" : null;
}

/** The chips on a folded permissions block: enough to decide whether to open it. */
export function permissionChips(p: Pick<PublicPlugin, "scope" | "sandbox">): string[] {
  const out: string[] = [`${p.scope} scope`];
  if (!p.sandbox) return out;
  const d = describeSandbox(p.sandbox);
  out.push(d.internet ? "internet" : "this app only");
  out.push(`reads ${d.reads.length}`, `runs ${d.programs.length}`);
  if (d.secretCount) out.push(`${d.secretCount} look${d.secretCount === 1 ? "s" : ""} like a login`);
  return out;
}

/** What stands in for a version: a plugin's manifest has none, so the commit it
 *  resolved to, or "local" for a folder. */
export function versionChip(p: Pick<PublicPlugin, "resolvedCommit" | "source">): string {
  if (p.resolvedCommit) return p.resolvedCommit.slice(0, 7);
  return p.source.kind === "local-path" ? "local" : "unpinned";
}

/** "3 installed · 1 update · 1 needs you", leaving out the zeros. */
export function pageSummary(total: number, updates: number, needsYou: number): string {
  return [`${total} installed`, updates ? `${updates} update${updates === 1 ? "" : "s"}` : "", needsYou ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""]
    .filter(Boolean).join(" · ");
}
