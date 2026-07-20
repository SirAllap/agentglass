// One answer to "what needs me right now".
//
// The question was being answered in three places that never spoke to each
// other: chats tracked their own attention state, deriveAlerts() read the live
// event stream, and the alerts panel polled the control plane for pending
// gates. Each was right about its own corner and blind to the rest — most
// visibly, the panel literally titled "What needs you" had no idea a chat could
// be blocked on a tool it wasn't allowed to run.
//
// This merges all of them into one list with one shape, so the panel and the
// header badge can never disagree about the count.

import type { PendingGate, Insight } from "../../../shared/types.ts";
import type { Alert, AgentCard } from "./derive.ts";
import type { Chat } from "./chatStore.ts";

/** Ordered by how much it wants you, not by what produced it. */
export type AttentionLevel = "blocking" | "error" | "warn";

export interface AttentionItem {
  id: string;
  level: AttentionLevel;
  /** Which mechanism raised it — for the icon and for grouping in the panel. */
  source: "gate" | "chat" | "agent" | "insight";
  text: string;
  ts: number;
  /** The session or chat this is about, when there is one, so the UI can offer
   *  to open it rather than just describe it. */
  target?: { kind: "session" | "chat"; id: string; app?: string };
}

const LEVEL_RANK: Record<AttentionLevel, number> = { blocking: 0, error: 1, warn: 2 };

export interface AttentionInput {
  gates: PendingGate[];
  insights: Insight[];
  alerts: Alert[];
  chats: Chat[];
  agents: AgentCard[];
}

/**
 * Merge every source into one triaged list.
 *
 * Sorted by severity first and recency second. deriveAlerts() sorts by time
 * alone, which lets a stale error from an hour ago outrank an agent that just
 * stopped to ask you something — the exact inversion this ordering fixes.
 */
export function collectAttention({ gates, insights, alerts, chats, agents }: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];

  // A held tool call is the only thing here where something is *actively*
  // stopped, waiting on a keystroke from you. It always sorts first.
  for (const g of gates) {
    out.push({
      id: "gate:" + g.id,
      level: "blocking",
      source: "gate",
      text: `${g.tool_name || "a tool"} is held for approval`,
      ts: g.created,
      target: g.session_id ? { kind: "session", id: g.session_id, app: g.source_app } : undefined,
    });
  }

  // A chat that hit a tool it may not run has given up on it and will not
  // proceed. Nothing but you resolves that.
  for (const c of chats) {
    if (c.attention === "blocked") {
      out.push({
        id: "chat:" + c.id,
        level: "blocking",
        source: "chat",
        text: c.blockedTool ? `${c.title}: ${c.blockedTool} was refused` : `${c.title} is blocked`,
        ts: c.messages[c.messages.length - 1]?.ts ?? c.createdAt,
        target: { kind: "chat", id: c.id },
      });
    }
  }

  // Finished, but on a question. The status ladder demotes these to idle so
  // they stop alerting forever — which is right, and is also why they need a
  // way back onto this list.
  for (const a of agents) {
    if (a.status === "idle" && a.outcome === "unanswered") {
      out.push({
        id: "unanswered:" + a.key,
        level: "warn",
        source: "agent",
        text: `${a.title ?? a.key} stopped on a question nobody answered`,
        ts: a.lastSeen,
        target: { kind: "session", id: a.session_id, app: a.source_app },
      });
    }
  }

  for (const al of alerts) {
    out.push({
      id: "alert:" + al.id,
      level: al.level === "error" ? "error" : "warn",
      source: "agent",
      text: `${al.agent}: ${al.text}`,
      ts: al.ts,
    });
  }

  // `info` is commentary, not a demand — it belongs in the panel's body, never
  // in the count.
  for (const i of insights) {
    if (i.severity === "info") continue;
    out.push({
      id: "insight:" + i.id,
      level: i.severity === "bad" ? "error" : "warn",
      source: "insight",
      text: i.title,
      ts: i.ts,
    });
  }

  // Two sources can describe the same stuck session — a gate and a derived
  // "waiting" alert for the same agent, say. Keep the more severe one so the
  // count reflects distinct problems rather than distinct detectors.
  const byTarget = new Map<string, AttentionItem>();
  const keep: AttentionItem[] = [];
  for (const item of out) {
    const k = item.target ? `${item.target.kind}:${item.target.id}` : "";
    if (!k) { keep.push(item); continue; }
    const prev = byTarget.get(k);
    if (!prev || LEVEL_RANK[item.level] < LEVEL_RANK[prev.level]) byTarget.set(k, item);
  }
  keep.push(...byTarget.values());

  return keep.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.ts - a.ts);
}

/** What the header badge and the panel's "N open" both count. One number. */
export const attentionCountOf = (items: AttentionItem[]): number => items.length;
