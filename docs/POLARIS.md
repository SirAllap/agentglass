# Polaris: pull request abilities for the orchestrator

Polaris lets the orchestrator of a project keep an eye on its pull requests. It
sorts each open pull request into a class, says why in one plain sentence, and
shows what to do next as one button. You decide, one door at a time, what it may
do on its own.

**The one rule: it never merges, and nothing leaves agentglass without your
click.** The only thing Polaris does on GitHub by itself is run a CI job again
when the runner dropped it, and that starts as a dry run.

- [Turning it on](#turning-it-on) · [The classes](#the-classes)
- [Doors](#doors) · [Presets](#presets)
- [Guardrails](#guardrails) · [The Agents view](#the-agents-view)
- [Assisted setup](#assisted-setup) · [Agent control](#agent-control)
- [Where it is stored](#where-it-is-stored)

---

## Turning it on

**Settings > Orchestration > Polaris.** The card follows the scope bar at the top
of the page: with a project selected you edit that project's own settings, and a
door you have not set there follows the global setting (the row says
*Inherits global*). *Global* and *All projects* edit the global layer.

Polaris is **off** until you press **Turn on**. Turning it on for a layer that
has no doors yet starts in **Guided**: it reads and drafts, and anything it would
run again is shown as a dry run first. Turning it off keeps your doors.

## The classes

| Class | Meaning | The button |
| --- | --- | --- |
| **Cleared to land** | Required reviews and checks are met. | Open on GitHub. You merge there, by hand. |
| **Needs you** | A conflict, a missing label, a failing check, a review or changes requested. | Open PR, or Review beacon when a draft waits. A red the base branch has too is marked *inherited* (see below). |
| **Drifting** | The runner dropped a CI job before any step ran. | Would relaunch (dry run), or nothing while Polaris relaunches it. |
| **In orbit** | Checks are still running. Quiet. | None. |
| **Docked** | A draft, a labelled or an excluded pull request. Never touched. | Undock. |
| **Landed** | Merged or closed. | Propose cleanup. |
| **Uncharted** | GitHub is not reachable, or has not said yet whether it merges. | None; the reason says why. |

Beside the button there are quieter clicks, each only what its word says: **Propose
a course** (a Drifting pull request), **Dock**, and **Leave it** (Polaris stops
mentioning that item for that reason).

## Doors

A door is one permission: off, or on and how. There are 17, in five groups. The
columns show where each preset puts it.

### Watching

| Door | Setting | Watch only | Guided | Full autopilot |
| --- | --- | --- | --- | --- |
| Follow pull requests | `follow` | On | On | On |
| Dock drafts, labelled and excluded pull requests | `dock` | On | On | On |
| Follow tracker cards, a few at a time | `cards` | Off | Off | On (2 at once) |

### Landing

| Door | Setting | Watch only | Guided | Full autopilot |
| --- | --- | --- | --- | --- |
| Say when a pull request is cleared to land | `cleared` | Quiet badge | Quiet badge | Quiet badge |
| Check the labels a pull request needs | `labels` | On | On | On |
| Count only people's approvals | `approvals` | People only | People only | People only |
| Name the red checks that gate nothing | `redsNamed` | Name them | Name them | Name them |

### Signals

| Door | Setting | Watch only | Guided | Full autopilot |
| --- | --- | --- | --- | --- |
| Wake the orchestrator when judgment is needed | `signals` | Off | On | On |
| Diagnose a red check | `diagnose` | Off | When I click | Automatically |

### Automatic

| Door | Setting | Watch only | Guided | Full autopilot |
| --- | --- | --- | --- | --- |
| Relaunch dropped CI jobs | `relaunch` | Off | Dry run | Live |
| Offer a re-run button for reds that fail on base too | `rerunButton` | No button | Button | Button |
| Write a beacon for the session that owns the pull request | `beacon` | Off | Draft for my click | Draft for my click |
| Match each item to its session | `match` | Use the match | Use the match | Use the match |
| Propose a course for a Drifting pull request | `course` | Off | After 24 h | After 4 h |
| Propose cleanup after a merge | `cleanup` | No proposal | Propose | Propose |
| Start a session for a card | `startSession` | Off | Off | One click |

### Limits

The numbers that cap a door sit together in this group: **Orbit limit** (cards
running at once, 1 to 5), **Attempts per run** (the first included, 1 to 3),
**Start tries** (1 to 3), **Drifting before a course** (4, 12, 24 or 48 hours),
and the door **Look again by itself** (no sooner than every 5 minutes or more, 1 to
5 steps in one pass). Each row names the door it belongs to and is dimmed while
that door is off.

### What acts today

Follow, Dock, the Landing group, Relaunch, Beacon, Match, Course, Cleanup and Look
again act. **Follow tracker cards**, **Wake the orchestrator**, **Diagnose a red
check**, **Re-run button** and **Start a session** can be set and are stored, and
nothing acts on them yet. A door that is set but not yet acting is never a
promise.

### Relaunching a dropped job

A job is *dropped* when it failed and none of its steps ran; a cancelled job, or
one that failed on its own steps, is never run again. The cap is the total number
of attempts of a workflow run, the first included: with the default 3 there are at
most two relaunches, and cap 1 never relaunches. Nothing is relaunched while a
check on the pull request is still running, and a run attempt is tried once.

In **Dry run** the item shows *would relaunch* and nothing is sent. **Live** is
the only position in which Polaris acts on GitHub by itself, and putting a door
live always asks you first.

### A red the base branch has too

A re-run of a failed check runs on the same merge commit, which still contains the
broken base, so it is red again whatever the base does later. Polaris takes the base
commit a failed run tested (the first parent of its merge commit; a run on a plain
commit says nothing about the base) and asks whether the same check is red there. If
it is, and every red of the pull request is like that, the item is **Needs you** with
the reason *inherited*, a grey chip, and it is never run again and never spends the
relaunch cap. One red of its own still reads as failing.

While at least one pull request inherits a red, the Pull requests section shows a
banner: the base, the check, since which commit, how many inherit it. Polaris reads
the base tip once per base, not once per pull request. When the check is green at a
newer base commit, the banner says the base is fixed, a note appears once, the
orchestrator is told once per fix (when **Signals** is on), and each row that has no
check running gets **Sync**, with **Sync all (N)** in the banner.

**Sync** merges the base into the pull request branch on GitHub, naming the head
commit you saw so it never races a push. It is only ever your click, once per pull
request per base fix, and it follows the Relaunch door: a dry run says what it would
do, and it is not real until you put that door live. A conflict or a moved head
answers with *conflict with base* and the item is Needs you. This machine's copy of
the branch is fast-forwarded when it is clean; otherwise it is left alone and a draft
for its session says to pull before pushing. If the copy has commits GitHub lacks,
the button says so before you press it. There is no automatic sync: that is not here.

### Looking again

Polaris looks at a project when GitHub or a session reports a pull request event
and on a timer, and never sooner than **Look again** says (5 minutes at least);
an event inside that gap is dropped. Open windows re-read when an event arrives;
nothing polls.

## Presets

A preset sets all 17 doors of a layer at once and is stored as a label:

- **Watch only**: reads and sorts. It never acts and never drafts.
- **Guided**: Watch only, plus signals, diagnose on click, relaunch as a dry run,
  the re-run button, beacon drafts, course and cleanup proposals.
- **Full autopilot**: Guided, plus cards, automatic diagnosis, live relaunch and
  one-click session starts.

Moving any single door afterwards reads **Custom**. Only a person chooses a
preset.

## Guardrails

Locked in every preset, and not settings:

- Polaris never merges. Merging is always your click, on GitHub.
- Nothing is posted, sent or changed outside the app without your click. A message
  to a session is a draft that your click sends.
- A door you have not set starts in its safe position: off, or a dry run. That
  includes doors a later version adds.
- Only relaunching dropped CI jobs acts on GitHub by itself. Bringing a branch up to date with its base is your click, never automatic.

And eight more it never does: write to a production or staging database, edit the
code of a pull request, weaken a test, touch a paused or running pull request,
start a third card while two run, claim a card for anyone, message the same session
twice for the same reason, close a working session or remove its worktree.

### Beacons

A beacon is a short message drafted for the session that owns a pull request. It
appears in **Waiting on you** with **Send**, **Edit** and **Discard**. Send is
your click, goes once per reason, and only to an idle session; Edit changes the
text and Discard drops it, and neither sends anything. A discarded reason is not
drafted again.

## The Agents view

With Polaris on, the Agents view gets a **Pull requests** section (class, number,
title, the reason and who it waits on), the orchestrator card shows a chip with
the preset ("Polaris, Guided"), and the items that wait on you are rows in
**Waiting on you**. When `gh` is missing or signed out, the items read as
**Uncharted** and say why.

## Assisted setup

**Assisted setup** (on the card) opens a terminal in the project with the engine
set for the builder role in Settings > Agent engines. The agent asks about your
team (who reviews, which checks gate a merge, whether CI drops jobs), then
proposes the doors one group at a time using the settings commands below. Without
an engine, or without an installed one, the button is disabled and links to
**Agent engines**.

## Agent control

An agent changes Polaris through the settings door, with `--root <project>` (a
chair uses its own project; any other caller is told to name one):

    agentglass-ui settings get polaris.enabled --root /home/me/code/orbit
    agentglass-ui settings get polaris.door.relaunch --root /home/me/code/orbit
    agentglass-ui settings set polaris.door.relaunch '{"mode":"off","cap":3}' --root /home/me/code/orbit

There are 18 settings: `polaris.enabled` and one `polaris.door.<door>` for each of
the 17 doors. A door's value is the whole object (`{"mode": "dry", "cap": 3}`).
`get` returns the value in force and the layer it came from (project, global or
default). The preset is shown by the card, never set by an agent.

| Change | What happens |
| --- | --- |
| A lower mode, or the same mode with a limit moved its narrower way (lower cap, size, tries or steps; higher hours or minutes) | Applies at once. |
| A higher mode, or a wider limit | Waits for your answer in the app. |
| Turning `polaris.enabled` on, or any door put live (relaunch live, automatic diagnosis, session starts, cards on) | Refused for an agent, always. The trust switch does not lift it. |
| Anything on the global layer | Yours only. |

## Where it is stored

In `config.json`, under `polaris`: a `global` layer and a `projects` map. Each layer
is `{ "version": 1, "enabled": true, "preset": "guided", "doors": { ... } }` and
has only what you set. A missing door reads its safe position, an unknown key is
kept, and a layer saved by a newer version is read, not refused.

When a later version adds a door, the card says so (*Format 1 to 2*): the new door
is off for you until you turn it on, your other doors do not change, and Dismiss
saves the layer in the new format with an Undo beside it.
