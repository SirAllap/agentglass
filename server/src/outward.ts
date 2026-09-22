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
  | "chat"          // a message in a channel
  | "outside";      // an MCP verb that acts somewhere else: send, create, delete

export interface Outward {
  kind: OutwardKind;
  /** Where it lands, in the words the command used: a branch, a number, a
   *  channel. Never invented — absent when the command did not say. */
  target?: string;
  /** The words that would appear. The whole point of showing the gate. */
  text?: string;
  /** Matched only by a generic MCP verb in the tool's name, not by anything
   *  that knows the server. A gate rule that names this exact tool on its
   *  allow list may release it: `create` and `delete` are also the verbs of
   *  local tools — a memory store, a scratch file — and a person has to be
   *  able to say so. Nothing else outward can be released by a rule. */
  generic?: boolean;
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
    outside: "acts outside this machine",
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
  // Delimiters of heredocs opened on the current line. Their bodies are text
  // being written somewhere, not commands: `cat <<EOF > notes.md` with "git
  // push" in the note is a note.
  const heredocs: string[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      buf += c;
      if (c === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    // An escaped quote is a character, not the start of a quoted run.
    if ((c === '"' || c === "'") && line[i - 1] !== "\\") { quote = c; buf += c; continue; }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line.slice(i));
      if (m) { heredocs.push(m[2]!); buf += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "\n" && heredocs.length) {
      out.push(buf); buf = "";
      let j = i + 1;
      while (heredocs.length && j < line.length) {
        const nl = line.indexOf("\n", j);
        const stop = nl < 0 ? line.length : nl;
        if (line.slice(j, stop).trim() === heredocs[0]) heredocs.shift();
        j = stop + 1;
      }
      heredocs.length = 0;
      i = j - 1;
      continue;
    }
    if ((c === "&" && line[i + 1] === "&") || (c === "|" && line[i + 1] === "|")) { out.push(buf); buf = ""; i++; continue; }
    // A lone `&` backgrounds one command and starts the next — unless it is
    // part of a redirect: `2>&1`, `&>`, `<&`.
    if (c === "&" && line[i - 1] !== ">" && line[i - 1] !== "<" && line[i + 1] !== ">") { out.push(buf); buf = ""; continue; }
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
    if ((c === '"' || c === "'") && cmd[i - 1] !== "\\") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * One shell word from the start of `s`, as the shell would read it: quoted and
 * unquoted runs joined (`'git'' push'` is one word), `\\"` inside double quotes
 * a quote, a backslash outside quotes escaping what follows.
 */
function shellWord(s: string): { word: string; end: number } {
  let w = "";
  let i = 0;
  while (i < s.length && s[i] !== " ") {
    const ch = s[i]!;
    if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      const stop = e < 0 ? s.length : e;
      w += s.slice(i + 1, stop);
      i = stop + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length && /["\\$`]/.test(s[j + 1]!)) { w += s[j + 1]; j += 2; }
        else { w += s[j]; j++; }
      }
      i = j + 1;
    } else if (ch === "\\" && i + 1 < s.length) {
      w += s[i + 1];
      i += 2;
    } else {
      w += ch;
      i++;
    }
  }
  return { word: w, end: i };
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
/** Commands that run the rest of their line as a command of its own. */
const LAUNCHERS = new Set(["env", "sudo", "exec", "nohup", "nice", "time", "timeout", "xargs", "command", "stdbuf"]);

/**
 * The command another shell is being asked to run, or undefined.
 *
 * `bash -c 'git push'` is a push, and it walked straight past everything below:
 * the quoted run is blanked out of the skeleton, so the verb was never seen.
 *
 * Read as tokens of the skeleton, and only where a command starts — the first
 * word, or the first after a launcher like `env` or `sudo` — so a `sh -c` in a
 * quoted grep pattern or an `eval` passed as an argument is not a wrapper. The
 * argument itself is read off the original at the same position, which the
 * skeleton preserves. Tokens rather than one regex, because a regex over a run
 * of flags backtracks, and this runs on every gated call.
 *
 * A variable used as a command (`g=git; $g push`) is not followed. That is
 * the next thing after this, and it is not here.
 */
function wrapped(c: string, k: string): string | undefined {
  const toks = [...k.matchAll(/\S+/g)];
  if (!toks.length) return undefined;
  const base = (t: string) => t.slice(t.lastIndexOf("/") + 1);
  let at = 0;
  if (LAUNCHERS.has(base(toks[0]![0])) || /^\w+=/.test(toks[0]![0])) {
    at = toks.findIndex((t, n) => n > 0 && n <= 8 && (SHELLS.has(base(t[0])) || t[0] === "eval"));
    if (at < 0) return undefined;
  }
  const name = base(toks[at]![0]);
  if (name === "eval") {
    const words: string[] = [];
    let rest = c.slice(toks[at]!.index! + toks[at]![0].length).trimStart();
    while (rest) {
      const { word, end } = shellWord(rest);
      words.push(word);
      rest = rest.slice(end).trimStart();
    }
    return words.join(" ");
  }
  if (!SHELLS.has(name)) return undefined;
  for (let j = at + 1; j < toks.length; j++) {
    const t = toks[j]![0];
    // Tested in two steps: `-[a-z]*c[a-z]*$` backtracks quadratically on a long
    // run of flags that does not end the way it hoped.
    if (/^-[a-zA-Z]+$/.test(t) && t.includes("c")) {
      const arg = toks[j + 1];
      return arg ? shellWord(c.slice(arg.index!)).word : "";
    }
    if (t === "-o" || t === "+o") { j++; continue; }
    if (!t.startsWith("-") && !t.startsWith("+")) return undefined; // a script, not a string
  }
  return undefined;
}

/** The value `gh api` would send — `body` when there is one, the GraphQL
 *  `query` next, else the first field — so a person is shown the words, not
 *  `body="ship`. */
function apiField(c: string): string | undefined {
  const re = /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s+|=)?([\w.\[\]]+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  const seen = new Map<string, string>();
  for (let m; (m = re.exec(c)); ) if (!seen.has(m[1]!)) seen.set(m[1]!, (m[3] ?? m[4] ?? m[5])!);
  return seen.get("body") ?? seen.get("query") ?? seen.values().next().value;
}

/**
 * Classify one shell command.
 *
 * A dry run is not an outward action, and neither is a read: `git push
 * --dry-run`, `gh pr view`, `gh pr list` all stay on this machine, and gating
 * them is how a gate becomes noise people click through.
 */
export function outwardShell(cmdLine: string, depth = 0): Outward | null {
  for (const cmd of commands(cmdLine)) {
    const c = cmd.replace(/\s+/g, " ").trim();
    const k = skeleton(c);
    const inner = wrapped(c, k);
    if (inner !== undefined) {
      // Three levels is more wrapping than any real command has. Past it the
      // call is held rather than passed: a string built to be unreadable is
      // not one to wave through.
      if (depth >= 3) return { kind: "outside", target: "a shell inside a shell, more than three deep" };
      const o = outwardShell(inner, depth + 1);
      if (o) return o;
      // Not `continue`: the rest of this command is still a command. The
      // wrapper's quoted argument is already blank in the skeleton.
    }
    if (/--dry-run\b/.test(k)) continue;

    if (/\bgit\s+(?:-\S+\s+)*push\b/.test(k)) {
      if (/\bpush\b.*\s-n(?:\s|$)/.test(k)) continue; // -n is --dry-run
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
    /* An API call that WRITES. A GET through the same tool is a read. `gh
       api` with no method is a GET — until it is given a field, when gh
       sends a POST, so the fields decide it unless a method is stated. The
       method is found on the skeleton and read off the original, so a quoted
       `-X 'DELETE'` is still a DELETE.
       GraphQL is the exception: gh always POSTs it, reads included, and
       agents read review threads through it all day. There it is a write only
       when the query is a mutation, or when it comes from a file nobody here
       can read. */
    if (/\bgh\s+api\b/.test(k)) {
      const mk = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))(?=\S)/.exec(k);
      const method = mk ? /^["']?([A-Za-z]+)/.exec(c.slice(mk.index + mk[0].length))?.[1]?.toUpperCase() : undefined;
      const fields = /(?:^|\s)(?:-[fF]|--(?:raw-)?field|--input)(?:[\s=]|\w+=)/.test(k);
      const graphql = /\bgh\s+api\s+(?:\S+\s+)*?graphql(?:\s|$)/.test(k);
      const writes = graphql
        ? /\bmutation\b/.test(c) || /(?:^|\s)--input(?:\s|=)/.test(k)
        : method ? /^(?:POST|PATCH|PUT|DELETE)$/.test(method) : fields;
      if (writes) {
        return { kind: "comment", target: firstWordAfter(k, /\bgh\s+api\s+(?:--?\S+\s+)*(\S+)/), text: apiField(c) };
      }
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
  /* Any other MCP server, by the verb in its tool's name. The lists above
     only know the servers somebody thought of; `push_files`, `send_email` and
     `create_or_update_file` walked past them. Matched on whole words of the
     name — `list_postings` is not a post — and only for MCP tools, whose
     names are somebody else's API. Named by the tool, because "acts outside
     this machine" alone tells a person nothing about what. */
  const m = /^mcp__.+__(.+)$/.exec(toolName);
  if (m) {
    // `HTTPPost` is HTTP + Post, and `add_comments` is still a comment.
    const words = m[1]!.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/);
    const stems = (w: string) => [w, w.endsWith("es") ? w.slice(0, -2) : "", w.endsWith("s") ? w.slice(0, -1) : ""];
    const verb = words.flatMap(stems).find((w) => OUTSIDE_VERBS.has(w));
    if (verb) {
      const kind: OutwardKind = verb === "push" ? "push" : verb === "merge" ? "merge" : verb === "comment" ? "comment" : "outside";
      return { kind, target: toolName, text, generic: true };
    }
  }
  return null;
}

const OUTSIDE_VERBS = new Set(["push", "create", "send", "merge", "delete", "post", "comment"]);
