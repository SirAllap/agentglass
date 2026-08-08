// What a picked element looks like once it has left the page, and how it is
// described to an agent.
//
// Pure, and separate from the component, because the description is the whole
// value of the feature: an agent that is told "the button is wrong" can do
// nothing, and one that is told which page, which selector, what the element
// currently is and what should change can go and find it.

export interface PickedElement {
  action: "copy" | "shoot" | "select" | "cancel" | "";
  selector: string;
  tag: string;
  id: string;
  classes: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** Parse what the injected picker left behind, or null if it is not that. */
export function parsePick(raw: unknown): PickedElement | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PickedElement>;
    if (!v || typeof v.action !== "string" || !v.action) return null;
    return {
      action: v.action as PickedElement["action"],
      selector: String(v.selector ?? ""),
      tag: String(v.tag ?? ""),
      id: String(v.id ?? ""),
      classes: String(v.classes ?? ""),
      text: String(v.text ?? ""),
      html: String(v.html ?? ""),
      rect: {
        x: Number(v.rect?.x ?? 0), y: Number(v.rect?.y ?? 0),
        width: Number(v.rect?.width ?? 0), height: Number(v.rect?.height ?? 0),
      },
    };
  } catch {
    return null;
  }
}

/** The element on the clipboard, for pasting into anything. */
export function elementForClipboard(p: PickedElement, url: string): string {
  return [
    `${p.tag}${p.id ? `#${p.id}` : ""} — ${p.rect.width}×${p.rect.height} on ${url}`,
    `selector: ${p.selector}`,
    ...(p.text ? [`text: ${p.text}`] : []),
    "",
    p.html,
  ].join("\n");
}

export type Intent = "change" | "question";

/**
 * The briefing for an agent, when somebody has pointed at something on a page
 * and said what is wrong with it.
 *
 * Leads with the ask, because that is the part a human wrote and the rest is
 * evidence. Names the page and the selector before the markup: an agent that
 * has the selector can go and look, whereas one that only has a blob of HTML
 * has to guess which file it came from.
 *
 * The "do not commit" line is the same boundary the conflict handoff draws: the
 * agent changes the code, a person reviews it.
 */
export function pageFeedbackPrompt(o: {
  url: string;
  title: string;
  intent: Intent;
  ask: string;
  element: PickedElement;
}): string {
  const p = o.element;
  return [
    o.intent === "change"
      ? "I want something changed on a page I am looking at, in this repo."
      : "I have a question about something on a page I am looking at, in this repo.",
    "",
    `What I want: ${o.ask.trim() || "(nothing written — ask me)"}`,
    "",
    `Page:     ${o.title || "(untitled)"}`,
    `URL:      ${o.url}`,
    `Element:  ${p.tag}${p.id ? `#${p.id}` : ""}${p.classes ? ` .${p.classes.split(/\s+/).filter(Boolean).slice(0, 4).join(".")}` : ""}`,
    `Selector: ${p.selector}`,
    `Size:     ${p.rect.width}×${p.rect.height}`,
    ...(p.text ? ["", `Its text: ${p.text}`] : []),
    "",
    "As it is rendered right now:",
    "",
    "```html",
    p.html,
    "```",
    "",
    o.intent === "change"
      ? "Find where this is produced in the source, make the change, and explain anything you had to decide. Do not commit — leave it for me to review."
      : "Find where this is produced in the source and answer the question. Do not change anything.",
  ].join("\n");
}

/** A tmux window name for the handoff. Short, and findable in a tmux list. */
export function feedbackWindowName(url: string): string {
  try {
    // `about:blank` parses perfectly well and has NO host, which is how this
    // first produced a window called "page-".
    const host = new URL(url).host.replace(/^www\./, "").split(".")[0];
    return host ? `page-${host}`.slice(0, 24) : "page";
  } catch {
    return "page";
  }
}
