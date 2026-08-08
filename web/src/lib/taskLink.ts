// The work item a pull request came from, whoever tracks it.
//
// A pull request usually exists BECAUSE of something — a card, an issue, a
// ticket. On a board whose job is "what wants something from me", that link is
// worth a chip: it is how you tell two similarly-titled pull requests apart and
// how you get from a review back to what was actually asked for.
//
// The reason this is not `cardRef` is the reason it exists. That module reads a
// CLICKUP card, and says so: "nothing else writes clickup.com". It is correct
// and it is not general — most people running agentglass have no ClickUp, some
// have GitHub issues, some have nothing at all. A chip that says "card" to
// somebody with no cards is worse than no chip, and a chip that quietly shows a
// Jira-shaped id as a ClickUp link is worse than that.
//
// So the shape here is provider-neutral and the rules are:
//
//   - Nothing configured, or nothing found → null. No chip, no gap, no
//     placeholder. The row is simply one thing shorter.
//   - Certain evidence (an address in the body) → a chip that can be opened.
//   - A convention (an id in the branch or the title) → a chip that is shown
//     but NOT dressed as any provider's, because `WEB-1042` is a shape half the
//     trackers in the world use.
//
// What it deliberately does not do is guess a provider from the shape of an id.
// The caller knows which task provider is connected; this only reads what the
// pull request carries.

import { cardRef } from "./cardRef.ts";

export interface TaskLink {
  /** What the chip says — the human id, because that is what people say out
   *  loud. */
  label: string;
  /** Handed to whatever finder the connected provider offers. */
  query: string;
  /** Present only when the pull request carried a real address. Without one
   *  there is nowhere honest to send a click. */
  url?: string;
  /**
   * How much this rests on.
   *
   * `certain` — the body carried an address, so the link is a fact.
   * `convention` — an id appeared in the branch or the title, which is a habit
   * this team has and other trackers share. Shown, and never presented as a
   * particular provider's, because being confidently wrong about which system
   * owns an id is how a chip sends somebody to a page that does not exist.
   */
  confidence: "certain" | "convention";
}

/**
 * Read the work item out of what the pull request already carries.
 *
 * `hasTaskProvider` is the caller's answer to "is anything connected that could
 * resolve this". With nothing connected, a convention-based id is not shown at
 * all: there is nowhere to take it, so it would be decoration that looks like a
 * control. An address in the body is still shown, because a URL opens without
 * anybody's credentials.
 */
export function taskLink(
  pr: { headRefName?: string; title?: string; body?: string },
  hasTaskProvider: boolean,
): TaskLink | null {
  const ref = cardRef(pr);
  return ref ? fromRef(ref, hasTaskProvider) : null;
}

/**
 * The rule, separated from the reading.
 *
 * Split out so it can be tested without a provider's address in a fixture:
 * this repository is public and a hook stops those going in, correctly. It is
 * also the honest unit — what is being decided here is what a piece of evidence
 * ENTITLES you to show, and that decision has nothing to do with which tracker
 * wrote the evidence.
 */
export function fromRef(
  ref: { label: string; query: string; url?: string; from: "url" | "branch" | "title" },
  hasTaskProvider: boolean,
): TaskLink | null {
  const confidence: TaskLink["confidence"] = ref.from === "url" ? "certain" : "convention";
  if (confidence === "convention" && !hasTaskProvider) return null;
  return { label: ref.label, query: ref.query, url: ref.url, confidence };
}

/** What the chip's tooltip should say, which is where the honesty about
 *  evidence lives — the chip itself is four characters and has no room for it. */
export function taskLinkTitle(t: TaskLink): string {
  return t.confidence === "certain"
    ? `${t.label} — linked from the description`
    : `${t.label} — read from the branch name, which is a convention rather than a link`;
}
