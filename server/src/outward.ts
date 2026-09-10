/*
 * WHAT LEAVES THE MACHINE — the calls a person has to see before they happen.
 *
 * Every orchestrator arrangement on this machine draws one line and draws it
 * in the same place: anything local and reversible is the agent's, and
 * anything a colleague can see is the owner's. Until now that line was held by
 * convention alone: an agent remembered to hold an outward call back, and it
 * worked — by culture, not by tooling.
 *
 * This is the tool. It classifies a tool call as OUTWARD — a push, a pull
 * request, a comment, a review, a ticket's state, a message in a chat — and
 * hands the route two things: the fact, and THE TEXT that would be sent. A
 * gate that says "Bash" is a gate people learn to wave through; one that shows
 * the sentence about to appear under somebody's pull request is one they read.
 *
 * Deliberately a matcher over commands rather than a list of blessed tools.
 * The agents here reach the outside through `git`, `gh`, `curl` and a handful
 * of MCP verbs, and the shape that matters is the same in all of them.
 *
 * WHAT IT IS NOT. It does not decide policy: which of these is worth holding,
 * and what happens when nobody answers, belongs to the route (the gate's own
 * comment makes that split, and it was right). And it is a HELP, not a wall —
 * a determined agent can compose a command this does not recognise. It raises
 * the floor from "everybody remembered" to "the obvious ways are seen", which
 * is the honest claim.
 */

export type OutwardKind =
  | "push"          // commits leave this machine
  | "pull-request"  // one is opened, or its body is edited
  | "comment"       // words appear under somebody's work
  | "review"        // an approval or a change request
  | "merge"         // it lands
  | "ticket"        // a tracker's state, assignee or comment
  | "chat";         // a message in a channel

export interface Outward {
  kind: OutwardKind;
  /** Where it lands, in the words the command used: a branch, a number, a
   *  channel. Never invented — absent when the command did not say. */
  target?: string;
  /** The words that would appear. The whole point of showing the gate. */
  text?: string;
}

/** How this reads on a gate, in one line a person can decide from. */
export function outwardLine(o: Outward): string {
  const what: Record<OutwardKind, string> = {
    push: "pushes commits off this machine",
    "pull-request": "opens or edits a pull request",
    comment: "posts a comment somebody will read",
    review: "submits a review",
    merge: "merges",
    ticket: "changes a ticket",
    chat: "posts in a chat channel",
  };
  return `This ${what[o.kind]}${o.target ? ` (${o.target})` : ""}`;
}

/* ── reading a shell command ─────────────────────────────────────────────
 *
 * Split on the operators that start a new command, so `cd x && git push` is
 * seen. Quoted text is left alone: the body of a comment is the thing being
 * extracted and chopping it at a `;` inside a sentence would show a person
 * half of what is about to be posted.
 */
function commands(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      buf += c;
      if (c === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if ((c === "&" && line[i + 1] === "&") || (c === "|" && line[i + 1] === "|")) { out.push(buf); buf = ""; i++; continue; }
    if (c === ";" || c === "\n" || c === "|") { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The value after a flag, quoted or not. Returns undefined rather than "" so
 *  "no body given" and "an empty body" stay different facts. */
function flag(cmd: string, ...names: string[]): string | undefined {
  for (const n of names) {
    const re = new RegExp(`${n}(?:=|\\s+)("([^"]*)"|'([^']*)'|([^\\s]+))`);
    const m = re.exec(cmd);
    if (m) return m[2] ?? m[3] ?? m[4];
  }
  return undefined;
}

const firstWordAfter = (cmd: string, re: RegExp): string | undefined => re.exec(cmd)?.[1];

/**
 * The command with its quoted runs blanked out.
 *
 * The verb is matched against THIS and the flags are read off the original,
 * because a quoted string is an argument and not a command: `grep -r 'gh pr
 * comment' docs/` is a search, and `git commit -m "remember to git push"` is a
 * commit. A classifier that cries wolf on those is a dialog people learn to
 * click through, which is worse than no dialog.
 */
function skeleton(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      out += c === quote && cmd[i - 1] !== "\\" ? (quote = null, c) : " ";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * Classify one shell command.
 *
 * A dry run is not an outward action, and neither is a read: `git push
 * --dry-run`, `gh pr view`, `gh pr list` all stay on this machine, and gating
 * them is how a gate becomes noise people click through.
 */
export function outwardShell(cmdLine: string): Outward | null {
  for (const cmd of commands(cmdLine)) {
    const c = cmd.replace(/\s+/g, " ").trim();
    const k = skeleton(c);
    if (/--dry-run\b/.test(k)) continue;

    if (/\bgit\s+(?:-\S+\s+)*push\b/.test(k)) {
      const to = /\bpush\s+(?:--?\S+\s+)*(\S+)(?:\s+(\S+))?/.exec(k);
      return { kind: "push", target: [to?.[1], to?.[2]].filter(Boolean).join(" ") || undefined };
    }
    if (/\bgh\s+pr\s+create\b/.test(k)) {
      return { kind: "pull-request", target: flag(c, "--base", "-B"), text: flag(c, "--body", "-b") ?? flag(c, "--title", "-t") };
    }
    if (/\bgh\s+pr\s+(?:comment|edit)\b/.test(k) || /\bgh\s+issue\s+comment\b/.test(k)) {
      return { kind: "comment", target: firstWordAfter(k, /\bgh\s+\w+\s+\w+\s+(\d+)/), text: flag(c, "--body", "-b") ?? flag(c, "--body-file", "-F") };
    }
    if (/\bgh\s+pr\s+review\b/.test(k)) {
      const how = /--(approve|request-changes|comment)\b/.exec(k)?.[1];
      return { kind: "review", target: [firstWordAfter(k, /\bgh\s+pr\s+review\s+(\d+)/), how].filter(Boolean).join(" ") || undefined, text: flag(c, "--body", "-b") };
    }
    if (/\bgh\s+pr\s+(?:merge|ready)\b/.test(k)) {
      return { kind: "merge", target: firstWordAfter(k, /\bgh\s+pr\s+\w+\s+(\d+)/) };
    }
    /* An API call that WRITES. A GET through the same tool is a read, and the
       default for `gh api` and `curl` without a method is a read. */
    if (/\bgh\s+api\b/.test(k) && /(?:^|\s)(?:-X|--method)\s+(POST|PATCH|PUT|DELETE)\b/i.test(k)) {
      return { kind: "comment", target: firstWordAfter(k, /\bgh\s+api\s+(?:--?\S+\s+)*(\S+)/), text: flag(c, "-f", "--field", "--raw-field") };
    }
    if (/\bcurl\b/.test(k) && /(?:^|\s)(?:-X\s*)?(POST|PATCH|PUT|DELETE)\b/.test(k)) {
      const url = /(https?:\/\/[^\s"']+)/.exec(k)?.[1] ?? "";
      const body = flag(c, "-d", "--data", "--data-raw");
      /* Named by where it lands, because "a POST" tells a person nothing about
         whether to allow it. A host this does not recognise is still outward:
         a write to somewhere on the internet is the thing being gated. */
      const kind: OutwardKind = /slack|discord|teams|mattermost/i.test(url) ? "chat"
        : /clickup|jira|linear|asana|trello|shortcut/i.test(url) ? "ticket"
        : "comment";
      return { kind, target: url.replace(/\?.*$/, "").slice(0, 120) || undefined, text: body };
    }
  }
  return null;
}

/**
 * Classify any tool call.
 *
 * MCP verbs are matched on their names because that is all a PreToolUse hook
 * is given, and the vocabulary is stable enough to be worth it: a verb with
 * `comment`, `post`, `send`, `create_task`, `update_task` or `merge` in it,
 * against a tool that is plainly a tracker or a chat, is outward.
 */
export function outwardAction(toolName: string, input: unknown): Outward | null {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");

  if (toolName === "Bash") return outwardShell(str("command"));

  const t = toolName.toLowerCase();
  const text = str("body") || str("text") || str("message") || str("comment") || str("content") || undefined;
  if (/slack|discord|teams|mattermost/.test(t) && /(post|send|message|reply)/.test(t)) {
    return { kind: "chat", target: str("channel") || str("channel_id") || undefined, text };
  }
  if (/clickup|jira|linear|asana|trello|shortcut/.test(t) && /(create|update|comment|move|status|assign|delete)/.test(t)) {
    return { kind: "ticket", target: str("task_id") || str("id") || str("issue") || undefined, text };
  }
  if (/github|gh_/.test(t) && /(comment|review|merge|create_pull|update_pull)/.test(t)) {
    const kind: OutwardKind = /merge/.test(t) ? "merge" : /review/.test(t) ? "review" : /create_pull|update_pull/.test(t) ? "pull-request" : "comment";
    return { kind, target: str("pull_number") || str("issue_number") || str("number") || undefined, text };
  }
  return null;
}
