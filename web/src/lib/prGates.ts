/**
 * The four gates under the pull request's title, and the verdict chip in the
 * dock, decided away from the screen. Both read the rows the Overview already
 * computes (lib/prOverviewView.ts), so the gates, the box and the dock cannot
 * say different things about the same pull request.
 */
import type { OverviewRow, RowKey } from "./prOverviewView.ts";
import type { Need } from "./prOverviewBody.ts";

export type GateTone = "ok" | "warn" | "bad" | "idle" | "merged" | "info";
export type GateTab = "checks" | "conversation" | "files" | "commits" | "review" | "overview";
export type PrState = "OPEN" | "MERGED" | "CLOSED";

export type Gate = {
  key: RowKey;
  label: string;
  value: string;
  tone: GateTone;
  /** The tab this gate is a shortcut to. */
  tab: GateTab;
};

/** What each gate is called, and where it goes. Reviews says "Reviews", the row says "Review". */
const GATE_ORDER: { key: RowKey; label: string; tab: GateTab }[] = [
  { key: "checks", label: "Checks", tab: "checks" },
  { key: "review", label: "Reviews", tab: "conversation" },
  { key: "conflicts", label: "Conflicts", tab: "files" },
  { key: "branch", label: "Branch", tab: "commits" },
];

/**
 * Four gates in a fixed order. A merged pull request has nothing left to gate:
 * the gates keep their words but go quiet (idle) so colour stays for what is
 * still open. A closed one the same.
 */
export function prGates(rows: OverviewRow[], state: PrState): Gate[] {
  return GATE_ORDER.map((g) => {
    const r = rows.find((x) => x.key === g.key);
    const tone: GateTone = state === "OPEN" ? (r?.tone ?? "idle") : "idle";
    return { key: g.key, label: g.label, value: r?.short ?? r?.text ?? "Not read yet", tone, tab: g.tab };
  });
}

/** The folded header's four dots: tone only, with the label for a screen reader. */
export function gateDots(gates: Gate[]): { key: RowKey; tone: GateTone; label: string }[] {
  return gates.map((g) => ({ key: g.key, tone: g.tone, label: `${g.label}: ${g.value}` }));
}

export type Chip = { tone: GateTone; label: string; /** The same answer in the fewest words, for a panel too narrow for `label`. */ short: string; sub: string; blockers: Gate[] };

/**
 * The dock's verdict chip. `reason` is the dock's own sentence (dockReason);
 * the chip's label is the short answer and the sentence is its sub-line.
 * Blockers are the gates that are not green, worst first, for the sheet.
 */
/** A blocker from "What is in the way", as a sheet row: the same list, so the chip count and the body heading cannot differ. */
export function needAsGate(n: Need): Gate {
  const tab: GateTab = n.act?.id === "rerun" || n.act?.id === "checks" ? "checks"
    : n.act?.id === "fix-conflicts" ? "files" : n.act?.id === "update-branch" ? "commits"
    : n.act?.id === "nudge" || n.act?.id === "ask-review" || n.act?.id === "threads" ? "conversation" : "overview";
  const value = [n.mono.join(", "), n.more > 0 ? `and ${n.more} more` : "", n.rest].filter(Boolean).join(" ");
  return { key: n.id as RowKey, label: n.lead, value, tone: n.tone, tab };
}

export function dockVerdict(i: { state: PrState; isDraft: boolean; reason: { kind: "ok" | "blocked" | "closed"; text: string }; gates: Gate[]; /** The Overview's blockers: when given they are the count and the list. */ needs?: Need[] }): Chip {
  const rank: Record<GateTone, number> = { bad: 0, warn: 1, info: 2, idle: 3, merged: 4, ok: 5 };
  const blockers = i.needs ? i.needs.map(needAsGate) : i.gates.filter((g) => g.tone === "bad" || g.tone === "warn").sort((a, b) => rank[a.tone] - rank[b.tone]);
  if (i.state === "MERGED") return { tone: "merged", label: "Merged", short: "Merged", sub: i.reason.text, blockers: [] };
  if (i.state === "CLOSED") return { tone: "idle", label: "Closed", short: "Closed", sub: i.reason.text, blockers: [] };
  if (i.isDraft) return { tone: "idle", label: "Draft", short: "Draft", sub: "Mark it ready for review to merge", blockers };
  if (i.reason.kind === "ok" && !blockers.length) return { tone: "ok", label: "Ready to merge", short: "Ready", sub: i.reason.text, blockers };
  const worst: GateTone = blockers.some((b) => b.tone === "bad") ? "bad" : "warn";
  const n = blockers.length;
  return { tone: worst, label: n ? `${n} thing${n === 1 ? "" : "s"} in the way` : "Not ready", short: n ? `${n} blocker${n === 1 ? "" : "s"}` : "Not ready", sub: i.reason.text, blockers };
}

/**
 * The commit message GitHub will write for each method, so the sheet can show it. It is read-only: the
 * panel's merge call carries the method and nothing else, and GitHub builds the message itself.
 */
export function commitMessagePreview(method: "squash" | "merge" | "rebase", i: { title: string; number: number; head: string; base: string }): string {
  if (method === "squash") return `${i.title} (#${i.number})`;
  if (method === "merge") return `Merge pull request #${i.number} from ${i.head}`;
  return `Each commit of ${i.head} is replayed onto ${i.base}. No new message.`;
}
