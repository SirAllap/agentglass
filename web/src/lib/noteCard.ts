// What a notification card says and how the stack folds repeats — pure, so
// the rules can be tested without drawing a card.
import type { SystemNote } from "./sysNotify.ts";
import { sourceOf } from "./notePolicy.ts";
import { noteSurface } from "./linkRouter.ts";

type Goto = NonNullable<SystemNote["goto"]>;

/** The view a pull request or a card opens in when it is not on the bench. */
export const VIEW_OF: Partial<Record<Goto["kind"], string>> = { pr: "Pull requests", card: "Tasks" };

/** Just the host of a link, so a button can say where it goes. */
export const hostOf = (url: string): string => {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return "link"; }
};

/**
 * What the card's one button says — every card names where its click goes.
 *
 *   gate        Allow / Deny on the card
 *   goto        "Open in Tasks · ORBIT-1042", "Open on the bench · orbit-web#318", "Open the terminal"
 *   link        "Open · docs.example.dev"
 *   app scheme  "Open the Slack app" (the app, not the message: a bus monitor cannot press its action)
 *   nothing     "Nothing to open · it stays in the bell"
 */
export type CardAction =
  | { kind: "gate" }
  | { kind: "goto"; label: string; target?: string }
  | { kind: "link"; label: string; target: string }
  | { kind: "app"; label: string }
  | { kind: "none"; label: string };

export function cardAction(n: Pick<SystemNote, "goto" | "url" | "urgency" | "key">, o: { bench: boolean; appLink: string | null; gate: boolean }): CardAction {
  if (o.gate) return { kind: "gate" };
  const g = n.goto;
  if (g) {
    const view = VIEW_OF[g.kind];
    const where = view ? (noteSurface(g.kind, o.bench) === "bench" ? "Open on the bench" : `Open in ${view}`) : null;
    switch (g.kind) {
      case "pr": return { kind: "goto", label: where!, target: `${g.repo.split("/").pop()}#${g.number}` };
      case "card": return { kind: "goto", label: where!, ...(g.label ? { target: g.label } : {}) };
      case "pane": return { kind: "goto", label: "Open the terminal" };
      case "git": return { kind: "goto", label: "Open in Git" };
      case "file": return { kind: "goto", label: "Open the file" };
      case "settings": return { kind: "goto", label: "Open Settings" };
      case "web": return { kind: "goto", label: "Open in agentglass browser", target: hostOf(g.url) };
    }
  }
  if (n.url) return { kind: "link", label: "Open", target: hostOf(n.url) };
  if (o.appLink) return { kind: "app", label: `Open the ${o.appLink} app` };
  return { kind: "none", label: "Nothing to open · it stays in the bell" };
}

export type LiveCard = { key: string; n: SystemNote; count: number };

/**
 * A new note onto the stack, newest first.
 *
 * Repeats from one app are one card with ×N: the newest words, the count of
 * everything it stands for. An agent that waits is never folded — each one is
 * a decision somebody has to make.
 */
export function stackCard(prev: readonly LiveCard[], key: string, n: SystemNote, max: number): LiveCard[] {
  if (n.urgency < 2) {
    const src = sourceOf(n);
    const twin = prev.find((c) => c.n.urgency < 2 && sourceOf(c.n) === src);
    if (twin) {
      const rest = prev.filter((c) => c !== twin);
      return [{ key: twin.key, n, count: twin.count + (n.count ?? 1) }, ...rest].slice(0, max);
    }
  }
  return [{ key, n, count: n.count ?? 1 }, ...prev].slice(0, max);
}

/** The bell's day heading for a row: "Today", "Yesterday", else a short date. */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at); const n = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
