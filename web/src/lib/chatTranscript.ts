// Turning a chat back into text you can paste somewhere else.
//
// The panel renders a conversation as folded tool rows, collapsed reasoning and
// styled bubbles, none of which survives a selection drag — dragging across it
// yields the labels of the chrome as often as the words. So the whole thing is
// serialised deliberately instead, as markdown, because everywhere a person
// pastes a chat (an issue, a PR, a message, another chat) renders markdown.
import type { Chat, ChatMsg, ChatTool } from "./chatStore.ts";

/** How much of a single tool's output to keep.
 *
 *  A `Read` of a large file or a verbose test run can be tens of thousands of
 *  characters, and a transcript that is 90% one command's stdout is not a
 *  conversation any more. Long outputs are marked as trimmed rather than
 *  silently cut, so what is missing is visible. */
const MAX_TOOL_OUTPUT = 2_000;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters]` : s;

/** `2026-07-26 19:04` in the viewer's own zone. Deliberately not ISO: this is
 *  read by a person, in the transcript, next to the words they said. */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toolBlock(t: ChatTool): string {
  const head = t.target ? `${t.name}(${t.target})` : t.name;
  const lines = [`- **${head}**${t.error ? " — failed" : ""}`];
  if (t.note) lines.push(`  - ${t.note}`);
  if (t.output) {
    // Indented fence: the row is a list item, and an unindented fence would end
    // the list and leave the rest of the tools orphaned at the top level.
    const body = clip(t.output.trimEnd(), MAX_TOOL_OUTPUT).split("\n").map((l) => `    ${l}`).join("\n");
    lines.push("  ```", body, "  ```");
  }
  return lines.join("\n");
}

function msgBlock(m: ChatMsg): string {
  const who = m.role === "user" ? "You" : "Claude";
  const parts = [`### ${who} · ${stamp(m.ts)}${m.historical ? " · (from the session's history)" : ""}`];
  // Reasoning goes in behind a fold, the same shape the panel gives it: present
  // for anyone who wants it, not in the way of the answer.
  if (m.thinking?.trim()) {
    parts.push("<details><summary>Thinking</summary>\n", m.thinking.trim(), "\n</details>");
  }
  if (m.text.trim()) parts.push(m.text.trim());
  if (m.images?.length) parts.push(`_[${m.images.length} image${m.images.length === 1 ? "" : "s"} attached]_`);
  else if (m.imagesDropped) parts.push(`_[${m.imagesDropped} image${m.imagesDropped === 1 ? "" : "s"} attached, not kept when the chat was restored]_`);
  if (m.tools.length) {
    parts.push(`<details><summary>${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}</summary>\n`);
    parts.push(m.tools.map(toolBlock).join("\n"));
    parts.push("\n</details>");
  }
  return parts.join("\n\n");
}

/** The whole conversation as markdown, header included.
 *
 *  The header is not decoration: a chat pasted into an issue is worthless
 *  without which directory it ran in and which model said it, and those are
 *  exactly the two things nobody remembers to add by hand. */
export function chatToMarkdown(chat: Chat): string {
  const head = [
    `# ${chat.title || "Chat"}`,
    "",
    `- Directory: \`${chat.cwd}\``,
    `- Model: ${chat.resolvedModel || chat.model}`,
    `- Permission mode: ${chat.mode}`,
  ];
  if (chat.sessionId) head.push(`- Session: \`${chat.sessionId}\``);
  if (chat.attachCommand) head.push(`- Terminal: \`${chat.attachCommand}\``);
  if (chat.usage) {
    // All four classes. This said `in / out` and dropped both cache figures,
    // which on a long chat is most of the tokens and most of the money — and a
    // transcript is something somebody pastes into a report, so a number
    // missing three quarters of itself travels further than most.
    const u = chat.usage;
    const cls = [
      `${u.input.toLocaleString()} in`,
      `${u.output.toLocaleString()} out`,
      u.cacheWrite ? `${u.cacheWrite.toLocaleString()} cache write` : "",
      u.cacheRead ? `${u.cacheRead.toLocaleString()} cache read` : "",
    ].filter(Boolean);
    head.push(`- Tokens: ${cls.join(" / ")} · $${u.costUsd.toFixed(4)}`);
  }
  // A chat with nothing in it still copies, and says so. Returning an empty
  // string would look exactly like the copy having failed.
  const body = chat.messages.length ? chat.messages.map(msgBlock).join("\n\n---\n\n") : "_(no messages yet)_";
  return `${head.join("\n")}\n\n---\n\n${body}\n`;
}
