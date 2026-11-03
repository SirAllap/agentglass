// What each tooltip on a board card says, apart from the card that draws it.
//
// The one tooltip (lib/tip.ts) takes a name, a detail, a tag, one sentence and
// a last line about what a click does. Writing those in the JSX would leave the
// words untestable and the copies to drift, so they are built here from the
// facts the card already holds.
import type { TipSpec } from "./tip.ts";
import type { CardView } from "./prCardView.ts";
import type { CardFace } from "./cardReviewers.ts";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const notesTip = (number: number, n: number): TipSpec => ({
  name: "Review notes", detail: `#${number}`, tag: "Draft",
  text: `${plural(n, "note")} you wrote on this pull request. Only you see them until you publish the review.`,
  hint: { key: "Click", text: "Open the pull request on its notes" },
});

export const labelsTip = (number: number, all: readonly string[]): TipSpec => ({
  name: "Labels", detail: `#${number}`, tag: "GitHub",
  text: "Labels on this pull request, not on the ticket.", pills: [...all],
  hint: { text: "Change them from the card menu, Edit labels" },
});

export const readOnlyTip = (number: number): TipSpec => ({
  name: "Read-only", detail: `#${number}`,
  text: "Your GitHub token has no write access to this repository. Merge, update and edits are off.",
});

export const noCardTip = (): TipSpec => ({ name: "No card linked", text: "Nothing in Tasks points to this pull request yet." });

export const noTrackerTip = (): TipSpec => ({ name: "No tracker connected", text: "Connect one in Settings and cards that name a ticket link to it." });

export function ticketTip(c: { id: string; status: string; priority?: string | null; color?: string }, hasCopy: boolean): TipSpec {
  return {
    name: c.id, mono: true, detail: "in Tasks", dot: c.color || "var(--text3)",
    text: `${c.status}${c.priority ? ` · ${c.priority} priority` : " · no priority"}`,
    hint: { key: "Click", text: "Open the card in Tasks", right: hasCopy ? "copy ID, name, link: right" : undefined },
  };
}

export const idTip = (id: string): TipSpec => ({
  name: id, mono: true, detail: "in Tasks", text: "No card by this id on your boards yet.",
  hint: { key: "Click", text: "Look for it in Tasks" },
});

export const faceTip = (f: CardFace): TipSpec => {
  const [name, ...rest] = f.title.split(" — ");
  return { name: name ?? f.login, text: rest.join(" — ") || undefined };
};

export const ringTip = (cv: CardView): TipSpec => {
  const { ring } = cv;
  if (ring.kind === "reading") return { name: "Checks", text: "Still reading them." };
  if (ring.kind === "none") return { name: "Checks", text: cv.kind === "finished" ? "No checks ran on this pull request." : "No checks have reported on this pull request yet." };
  const n = ring.green + ring.red + ring.running;
  return {
    name: "Checks", text: `${ring.green} of ${n} passed${ring.red ? `, ${ring.red} failing` : ""}${ring.running ? `, ${ring.running} running` : ""}.`,
  };
};

export const cellTip = (label: string, title: string): TipSpec => {
  const lines = title.split("\n");
  return lines.length > 1 ? { name: label, text: lines.join(", ") } : { name: label, text: title };
};

/** The event line's tooltip: the sentence that filed the card, the test it names, the days of quiet. */
export function eventTip(o: { reason: string; test?: { title: string; more: number } | null; quiet: string | null; at: string; author?: string }): TipSpec {
  const reason = o.reason.trim();
  const test = o.test ? `Test: ${o.test.title}${o.test.more > 0 ? ` and ${o.test.more} more` : ""}.` : "";
  return {
    name: "Last activity", detail: o.at,
    text: [o.author ? `Opened by ${o.author}.` : "", reason || "Nothing yet.", test, o.quiet ? `${o.quiet}.` : ""].filter(Boolean).join(" "),
  };
}
