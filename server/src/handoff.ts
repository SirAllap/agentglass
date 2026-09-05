/*
 * HANDOFF — a live conversation, summarised and seeded into another agent.
 *
 * "Hand a live Claude conversation over to Codex, or summarise it and seed it
 * into a sibling pane." The session record already holds everything a successor
 * needs: what was asked, in the person's own words; what the agent said back;
 * the files it touched; where it is running. This composes that into a brief
 * — the task, the recent exchange, the files, and the one instruction that
 * matters, "continue, do not start over" — and the ticket path seats the
 * chosen CLI on the bench with the brief as its first message. No summariser
 * model in the middle: the brief is the record, trimmed, and a second agent
 * reads records better than it reads somebody's summary of them.
 */

const ONE_LINE = (s: string) => s.replace(/\s+/g, " ").trim();

/** How much of the exchange rides along: the first ask whole, then the last
 *  few turns, each cut — a brief is not a transcript. */
/** What the brief reads off a session — narrowed so a test can hand it a
 *  record without every field a session detail carries. */
export interface HandoffSource {
  first_prompt?: string | null; custom_title?: string | null; ai_title?: string | null; summary?: string | null; cwd_path?: string | null;
  conversation: { role: "user" | "assistant"; text: string }[];
  changes: { file_path: string }[];
}

export function handoffBrief(d: HandoffSource, opts: { turns?: number; each?: number } = {}): string {
  const turns = opts.turns ?? 8;
  const each = opts.each ?? 700;
  const title = d.custom_title || d.ai_title || "";
  const first = (d.first_prompt || d.conversation.find((c) => c.role === "user")?.text || "").trim();
  const recent = d.conversation.slice(-turns).map((c) => `${c.role === "user" ? "Person" : "Agent"}: ${ONE_LINE(c.text).slice(0, each).trimEnd()}${c.text.length > each ? " …" : ""}`);
  const files = [...new Set(d.changes.map((c) => c.file_path).filter(Boolean))].slice(0, 30);
  const lines: string[] = [];
  lines.push("You are taking over a conversation another agent was having in this checkout. Continue it; do not start over, do not redo what is done.");
  if (title) lines.push(`Title: ${title}`);
  if (d.cwd_path) lines.push(`Checkout: ${d.cwd_path}`);
  if (d.summary) lines.push(`Summary so far: ${ONE_LINE(d.summary).slice(0, 600)}`);
  if (first) lines.push("", "The task, as first asked:", first.slice(0, 2000));
  if (recent.length) lines.push("", `The last ${recent.length} turns:`, ...recent);
  if (files.length) lines.push("", "Files it touched:", ...files.map((f) => `- ${f}`));
  lines.push("", "Begin by saying, in two lines, where you think it left off and what you will do next.");
  return lines.join("\n");
}
