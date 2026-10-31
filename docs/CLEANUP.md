# Cleaning up after a merged pull request

A merged pull request leaves things on your computer: the extra checkout folder,
the local branch, stashes, Docker containers and images built for it, scratch
notes, an agent tab. agentglass can list those, show how much space they take,
and remove them.

**The one rule: it is an offer.** Nothing is removed unless you press the button
(or approve the card an agent raised), except when you choose **Automatic**
yourself. Everything stays on this computer: the branch on GitHub, the pull
request and any task tracker are never touched.

- [In the app](#in-the-app) · [From a terminal or an agent](#from-a-terminal-or-an-agent)
- [What a plan holds, in order](#what-a-plan-holds-in-order)
- [When it refuses](#when-it-refuses) · [What is never touched](#what-is-never-touched)
- [Per-project settings](#per-project-settings)

---

## In the app

**Settings > Git and pull requests > After a PR is merged.** The choice is per
project; the picker at the top right says which one you are editing.

| Mode | What happens |
| --- | --- |
| **Off** | No offer. Leftovers stay until you remove them yourself. |
| **Ask** (default) | Every merged PR is offered a cleanup. You read the plan and confirm; from a terminal, `agentglass-cleanup <pr>` shows the same plan. |
| **Offer at merge time** | The cleanup is offered right after you merge a PR, and on any other merged PR, as in Ask. |
| **Automatic** | The app cleans a merged PR on its own, in the background. A PR with a safety block is left alone, and the block is shown on the PR with its reason. One quiet row under Housekeeping in the Lantern says what was cleaned. |

**Also clean up merged PRs older than N days** (off by default, 1 to 365) runs the
same background clean on old merged PRs, with the same safety blocks. It works in
any mode.

**What to include** has one tick per kind: Docker, Worktree, Branch, Stashes,
Evidence, Notes, Tab, Agent scratch, Session history. A kind you untick is never
touched, in any mode. All are on by default except **Session history**, which is
off: it is the record you resume or read what the agent did from.

**How many screens you see**, by mode:

- **Automatic** never opens a dialog. The server does the work (nothing in the window
  starts it) and the result is a quiet row under Housekeeping and the PR's badge.
- **Offer at merge time**: the tick in the merge dialog is your consent. After the merge
  the cleanup runs with the default selection and one toast says
  `Cleaned ORBIT-1042 · 6.4 GB freed`, with **Details** for the list. The review
  dialog opens instead only when the plan needs a look: a safety block, a PR that was
  not merged, one item that is more than 90 % of the size, or an item of a kind a new
  project would not include (the session history).
- **Ask**, and the PR's **Clean up local leftovers** button in any mode, keep the review
  dialog. A finish with nothing failed closes into the same toast; a failure stays on
  screen with Retry.
- The PR's badge changes the moment a run ends, from the server's own re-read of what is
  left: **Cleaned up · 6.4 GB freed** and no button when nothing remains, or the
  leftovers that remain after a partial failure. Two runs of one PR are never in flight
  together; the second is refused.
- **Evidence folders** (Settings, under What to include, while Evidence is ticked) is the
  list behind `cleanup.evidenceRoots`; empty means no evidence is found, and the page says so.
  **Briefs folder** (under it, while Notes is ticked) is `briefsDir`: briefs holding the card
  id are moved to `archive/` inside it, never deleted; empty is off. **Other folders** (while
  Worktree is ticked) is the list behind `cleanup.otherFolders`, below.
- The dialog's footer has a quiet **Prune build cache** link when Docker reports
  something reclaimable, with its own confirm (see below).

**No button without leftovers.** Every place that offers **Clean up** (the card, a row of
the Closed list, the PR panel's footer) first asks the server for a cheap, local-only count
(`GET /cleanup/inventory`: git, Docker and the checkout folder, never GitHub, one request for
all the rows in view, kept per PR and state). The button and the tinted size ("6.4 GB", with
`Docker 6.1 GB · Worktree 222 MB` on hover) appear only when at least one real item exists;
the app's own bookkeeping rows do not count. While the count is read there is a quiet
placeholder, and if it cannot be read there is no button (the PR panel shows a muted
"Leftovers ?" with the reason). Ceiling: an agent tab left open is not counted here; the
full plan behind the button still lists it.

The safety blocks below apply in every mode; no setting turns them off.

## From a terminal or an agent

```
agentglass-cleanup <pr> [--repo <path>] [--dry-run] [--yes PLAN_ID]
                        [--exclude ITEM_ID ...] [--confirm-not-merged]
```

- **The dry run is the default.** `agentglass-cleanup 77` prints the plan, every
  block that makes it unsafe, and changes nothing. `--dry-run` says so out loud.
- **`--repo`** names a repository other than the one you stand in.
- **The plan id** is a hash of what the plan would do and the checkout's HEAD.
  `--yes <plan id>` recomputes the plan from the live state and refuses a
  different id, so the plan you read is the plan that runs. If anything moved
  in between, run the dry run again.
- **`--exclude`** leaves one item out of the run, by the id the plan printed
  (for example `branch:ORBIT-1042-fix-x`).
- **`--confirm-not-merged`** is needed for a pull request that was closed
  without a merge. Without it the run is refused, for a person and an agent
  alike; the dry run still prints the plan.

**What an agent's `--yes` does.** It does not run anything. It raises an
approval card for you, in the corner of the window and in the Lantern under
Waiting, and the command answers `{"ok": true, "approval": "pending", ...}`.
The card shows the total size, the size per kind, and the full list of items. The
words on it come from the plan the server computed, never from what the agent
wrote. **Approve and clean** runs the plan (checked again at that moment);
**Decline** removes nothing. A card nobody answers is declined when it expires.
A person running the command from the app needs no card.

Every answer is one JSON object on stdout; the exit code is 0 when it worked.

## What a plan holds, in order

A plan lists the items and a run goes through them in this order:

1. **Tab**: the agent tab that worked on the PR, once nothing runs in it.
2. **Docker**: containers (stopped, then removed), volumes, image tags, and test
   databases if you set that up.
3. **Worktree**: the extra checkout folder (`git worktree remove`, then prune).
4. **Branch**: the local branch, then a `git fetch --prune` (if that fails it is
   reported and nothing else depends on it).
5. **Stashes** that name the branch: each is saved as a patch file first, then
   dropped.
6. **Agent scratch** and **Session history**: what the agent keeps for that
   checkout (see below).
7. **Evidence, notes and briefs**: folders and files you configured (see below).
   Briefs are moved to an `archive` folder, not deleted.
8. This app's own bookkeeping for the PR, and, if you set a worklog folder, one
   line appended to that day's worklog.

Docker things and scratch files are matched by the **card id** at the start of the
branch name (`ORBIT-1042-retry-queue` has the id `ORBIT-1042`). The id has to
stand alone: `ORBIT-104` never matches `ORBIT-1042`. A branch without a card id
skips those steps. Things are removed by their exact name, never by a pattern.

### Evidence folders

`cleanup.evidenceRoots` is a list of folders that each hold the evidence of many
cards, for example `~/Documents/projects/orbit`. A folder **directly inside** a
root belongs to the card when its name starts with the card id (any case, not
followed by another digit: `orbit-1042-pol-timeout` is `ORBIT-1042`'s, `ORBIT-10420-pol`
is not) or with the branch name (`fix/cleanup-gaps` matches `fix-cleanup-gaps-shots`;
a branch shorter than 8 characters is never used as a prefix). It works for a branch
without a card id too. The default is an empty list: nothing is looked for, and the
plan says so in one line. A root itself, a folder outside every root and a name that
is not the card's are never removed.

### Other folders

Some leftovers of a card do not start with its id: a baseline checkout made for a proof
of life, named by the card's digits. `cleanup.otherFolders` is a list of patterns, each a
literal folder and a last name with `{card}` (`ORBIT-1042`) and/or `{number}` (`1042`),
for example `~/code/orbit-pol-master-{number}*`. `*` and `?` stay inside one name, and
`{number}` must stand between non-digits (`1042` is not `10420` or `21042`). A match is a
git worktree of the repository (whatever branch it is on, even `master` or detached),
which is removed like the card's own worktree and keeps its safety blocks (uncommitted
changes, a live session), or a plain folder, empty or not, shown with its size and removed
by a container when root owns the files. The plan lists them as **other folder** and the
PR's badge counts them. The main checkout, a folder that holds it, the home directory, a
folder directly in it and any other git checkout are refused with a note. They go with
the Worktree tick.

### Agent scratch and session history

The agent keeps data per checkout, in folders named after the checkout's exact path
with `/` replaced by `-` (`/work/orbit-ORBIT-1042` is `-work-orbit-ORBIT-1042`):

| Kind | Folders | Default |
| --- | --- | --- |
| **Agent scratch** | `~/.cache/claude-cli-nodejs/<key>`, `~/.cache/claude-tmp/<uid>/<key>` | on; the agent makes them again |
| **Session history** | `~/.claude/projects/<key>` | off; "Kept so you can resume or read what the agent did" |

Only those exact folders are listed, with their sizes, never the folder above them;
a live session in the checkout blocks the whole plan like anything else. Ceilings:
only Claude Code's layout is known, other engines are not here; a path with a dot or
a space in it is not matched; and once the checkout is gone the key cannot be derived,
so these two kinds are found in the same plan as the worktree, not afterwards.

## The Docker build cache

The build cache is shared by every project on the machine and is not any one pull
request's leftover, so it is **not in the plan and never runs by itself**. It is a
separate action for you: `GET /cleanup/build-cache` reads its size
(`docker buildx du`) and `POST /cleanup/build-cache/prune` runs
`docker builder prune -f`. The person presses it, after a confirm that says every
project shares it and the next build is slower; an agent's request is refused.

## When it refuses

A **block** is listed by the dry run and refuses the run. The plan is left as it
is until you fix the cause:

- the worktree has **uncommitted changes**;
- the branch has **commits that are not in the merged PR**;
- another **open PR is stacked on it**, or uses the branch;
- a **live session or process** runs in the worktree (or its tab);
- it is the **main checkout** or the repository's **default branch**;
- GitHub or git could not be read, so it is not known whether the above holds.

In Automatic mode a block means the PR is left alone, and its reason is kept.

## What is never touched

- The **shared stack**: the container names you list as shared are never stopped
  or removed, whatever their name says.
- The repository's **main checkout** and its **default branch**.
- The **remote branch**, the pull request, and **anything on GitHub or in a
  tracker**. The one network call is the `git fetch --prune` above.
- Docker **images and volumes** whose name or tag does not contain the card id.
- A container that only **shares a Docker Compose label** with the checkout. Compose
  labels are never used to pick what to remove: the project label is the same for
  every checkout, so it would point at the wrong stack. Such a container is
  mentioned in the plan notes and left alone.
- A running container's image.

## Per-project settings

Anything that is yours rather than every repository's is a per-project setting,
`cleanup.config`, and **every field is empty by default**: a step with nothing
configured is skipped, never guessed. An agent reads and writes it with
`agentglass-ui settings set cleanup.config '<json>' --root <repo>`; a wider list
deletes more, so a widening waits for your approval.

| Field | What it does |
| --- | --- |
| `sharedContainerNames` | Container names that are never stopped or removed. |
| `dockerImageTagTemplate` | An exact image tag with `{slug}` in it, removed besides the images whose tag contains the card id. |
| `testDbPrefix`, `testDbCommand` | Scratch databases whose name starts with the prefix and holds the card id are dropped, using this `psql` command to list and drop them. Both empty: skipped. |
| `stashArchiveDir` | Where a stash's patch is saved before the stash is dropped. Empty: the app's own state folder. |
| `evidenceDirs` | Folders to remove, written with `{slug}` in the last folder name only. The newer way is `cleanup.evidenceRoots`, below. |
| `notesDirs` | Folders searched for notes to remove. |
| `transientMarkers` | A note is removed only when its name holds the card id **and** one of these words. |
| `briefsDir` | Briefs holding the card id are moved to `archive/` inside it. |
| `worklogDir` | For a merged PR, one line `PR merged: <title> <url>` is added to the day's file, once. |

Paths are absolute or start with `~/`. An example, with invented names:

```json
{
  "sharedContainerNames": ["orbit-db", "orbit-cache"],
  "dockerImageTagTemplate": "acme-orbit:{slug}",
  "testDbPrefix": "orbit_test_",
  "testDbCommand": "psql -h localhost -U orbit postgres",
  "stashArchiveDir": "~/orbit-notes/stash-patches",
  "evidenceDirs": ["~/orbit-notes/evidence/{slug}"],
  "notesDirs": ["~/orbit-notes/scratch"],
  "transientMarkers": ["-ci-", "-scratch-"],
  "briefsDir": "~/orbit-notes/briefs",
  "worklogDir": "~/orbit-notes/worklog"
}
```

With that, cleaning `ORBIT-1042` removes `~/orbit-notes/evidence/ORBIT-1042-retry`,
a note called `ORBIT-1042-ci-run.md` in `scratch`, and moves
`~/orbit-notes/briefs/ORBIT-1042.md` to `briefs/archive/`, and it leaves
`orbit-db` and `orbit-cache` running whatever else it finds.

`cleanup.mode`, `cleanup.autoCleanDays`, `cleanup.include` and
`cleanup.evidenceRoots` and `cleanup.otherFolders` are the settings behind the Settings
section above (the last two are JSON lists, empty by default); an agent may read them and
may tighten them at once, while a looser value, or a longer list, waits for you.

After a run, the report carries `remaining`: a plan read again the moment it ended
(`items`, `bytes`, `blocks`). An empty `items` is "cleaned up"; anything in it is
what is still there, for example after a partial failure.

The HTTP routes behind the command are in [CONFIG.md](CONFIG.md).
