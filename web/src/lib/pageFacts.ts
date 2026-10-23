import { useSyncExternalStore } from "react";
import type { HeaderChip } from "./settingsNav.ts";

/**
 * Small facts a settings page knows and the nav does not: how many sites a
 * cookie import found, how many rules are typed but unsaved. A page publishes
 * one while it is mounted; the header reads it for its chip. The nav's own marks
 * stay the only source of "on / off / needs you" (settingsNav.ts): a fact here
 * only adds a word or a chip to a state that is already shown.
 */
export type PageFacts = {
  volume?: "Quiet" | "Normal" | "Loud";
  tmuxVersion?: string;
  taskSources?: number;
  importableSites?: number;
  unsavedRules?: number;
};

let facts: PageFacts = {};
const subs = new Set<() => void>();

export function setPageFact<K extends keyof PageFacts>(k: K, v: PageFacts[K]): void {
  if (facts[k] === v) return;
  facts = { ...facts, [k]: v };
  subs.forEach((f) => f());
}

export function usePageFacts(): PageFacts {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => facts, () => facts);
}

/** The header's chips for a page: what the nav says, with the page's own facts folded in. */
export function pageChips(id: string, chips: HeaderChip[], f: PageFacts): HeaderChip[] {
  const out = chips.slice();
  const swap = (from: string, text: string) => { const i = out.findIndex((c) => c.text === from); if (i >= 0) out[i] = { ...out[i]!, text }; };
  switch (id) {
    case "notifications":
      if (f.volume) swap("On", `${f.volume} volume`);
      break;
    case "tmux":
      if (f.tmuxVersion) swap("tmux ready", `tmux ${f.tmuxVersion}`);
      break;
    case "keys":
      // The recorder refuses a key another action holds, so a clash cannot be saved.
      out.unshift({ tone: "ok", text: "No conflicts" });
      break;
    case "tasks":
      // "N sources" read as N connected, beside rows that say Not connected: this counts the lanes the Tasks bar shows.
      if (f.taskSources !== undefined) out.unshift({ tone: f.taskSources ? "ok" : "off", text: `${f.taskSources} on the board` });
      break;
    case "browser":
      if (f.importableSites) out.unshift({ tone: "ok", text: `${f.importableSites} ${f.importableSites === 1 ? "site" : "sites"} to bring in` });
      break;
    case "terminal":
      if (f.unsavedRules) out.unshift({ tone: "warn", text: `${f.unsavedRules} unsaved` });
      break;
  }
  return out;
}
