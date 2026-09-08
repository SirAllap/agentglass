/*
 * THE DOCTRINE — what the orchestrator is told about this project, in a file
 * a person edits.
 *
 * Not a constant in the source, and not a row in the database. A doctrine is
 * the house rules of one project ("nothing leaves this machine", "the queue is
 * yours, master is not"), it is re-read every time the seat is opened, and the
 * person who owns those rules must be able to open the file, read the whole
 * thing, and change a line without a migration. So: one markdown file per
 * project, under the app's own data directory — the same choice bench notes
 * made, and for the same reason. Work notes live outside the repository.
 *
 * The template below is what a project gets on its first seating. It is
 * deliberately generic: the rules that matter to one workplace (a card
 * prefix, a review flow, a tracker) belong in that machine's copy, never in a
 * public repository's source.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Big enough for a page of house rules, small enough that this is not a
 *  document store: what is being written is read by an agent every seating. */
export const MAX_DOCTRINE = 64 * 1024;

function doctrineDir(): string {
  return join(
    process.env.AGENTGLASS_DOCTRINE
      ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentglass"),
    "doctrine",
  );
}

/**
 * A filename for a checkout that survives two projects with the same basename.
 *
 * `~/code/orbit` and `~/work/orbit` are different projects with one basename,
 * and a doctrine written for one would silently become the other's. So the
 * name carries the basename (for a human opening the folder) and a short hash
 * of the whole path (so it is unique).
 */
export function doctrineSlug(root: string): string {
  let h = 5381;
  for (let i = 0; i < root.length; i++) h = ((h * 33) ^ root.charCodeAt(i)) >>> 0;
  const plain = basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "project";
  return `${plain}-${h.toString(36)}`;
}

export function doctrinePath(root: string): string {
  return join(doctrineDir(), `${doctrineSlug(root)}.md`);
}

/** The starter every project gets, with its own name in it. */
export function doctrineTemplate(root: string): string {
  const name = basename(root) || "this project";
  return `# The orchestrator's post — ${name}

This file IS the prompt. It is read fresh every time the seat is opened, so a
line changed here is a rule changed on the next seating.

## Who you are

You keep the field for the agents working in ${name} on this machine. **You do
not write code**: other agents hold the checkouts. You know at all times who is
on what, who is stopped and why, and you answer for them — one question, one
answer, without anybody having to read a board.

Be brief. Lead with what needs a person.

## What you read first, every round

1. This file. It is the rules, and it can have changed since the last round.
2. The field, as facts and not as memory:

\`\`\`bash
git -C ${root} worktree list
for w in ${root}*/; do
  echo "== $w $(git -C "$w" rev-parse --abbrev-ref HEAD) $(git -C "$w" status --porcelain | wc -l) dirty"
  git -C "$w" log --oneline -1
done
\`\`\`

3. Who is actually alive. A row on a board is not a process.

## What you do with it

- **One line per round** in your log: who is working, who is stopped and since
  when, what changed since last time. If nothing changed, say so and stop.
- **Notice what nobody is watching**: a checkout with commits and no live
  owner, an agent stopped for over an hour, a merged branch still sitting
  there, a run that died.
- **Say who a thing is waiting for.** "Ready" is not an outcome; "ready, and it
  is waiting on you" is.

## What you never do

- **Nothing leaves this machine.** No push, no pull request, no comment on a
  forge. If something needs to leave, you ask.
- **You do not merge**, and you do not offer to. You say a branch is ready and
  who it is ready for.
- **You do not decide what costs money** or what is irreversible. Everything
  else you decide yourself and say in one line with the reason — waiting is not
  recoverable, a mistake in a local checkout is.
- **No \`git add -A\` and no \`git stash\`** in a checkout that is not yours: you
  would carry off work another agent has in flight. Stage by path.

## Before you propose anything

Grep for the scar first — your own log, and the git history. Work that is
already done, and a fix that reintroduces a bug somebody already measured, are
the two mistakes a post like this makes. Measure before believing anything,
including what an agent tells you about itself.
`;
}

/** The doctrine for a project, seeded from the template the first time. */
export function readDoctrine(root: string): { path: string; text: string; seeded: boolean } {
  const path = doctrinePath(root);
  if (existsSync(path)) return { path, text: readFileSync(path, "utf8"), seeded: false };
  const text = doctrineTemplate(root);
  mkdirSync(doctrineDir(), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, text, seeded: true };
}

export function writeDoctrine(root: string, text: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "doctrine must be text" };
  if (text.length > MAX_DOCTRINE) return { ok: false, error: `a doctrine is at most ${Math.round(MAX_DOCTRINE / 1024)} KB` };
  if (!text.trim()) return { ok: false, error: "an empty doctrine would seat an agent with no rules" };
  const path = doctrinePath(root);
  mkdirSync(doctrineDir(), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { ok: true, path };
}
