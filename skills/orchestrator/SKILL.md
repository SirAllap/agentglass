---
name: orchestrator
description: Use when somebody asks for an orchestrator, a lead agent, a coordinator, or somebody to "keep an eye on" the agents working on a project — and when asking about who is minding a project, who is blocked, or what the orchestrator last said. Puts a seat in a project's chair inside agentglass (with its own rules, queue, memory and view) instead of a loose tmux session nobody else can see.
---

# The orchestrator's seat

An orchestrator is an agent whose job is NOT to write code. It knows who is
working on what, who is stopped and why, hands work out, and answers for the
whole field in one line. In agentglass it is a SEAT: one per project, with its
own rules file, its own queue, the project's field in front of it, and a view.

Seating one by hand — a tmux window, a prompt pasted in, a loop — makes an
agent nobody else can see and nobody can reproduce. This does it properly.

## Put somebody in the chair

```bash
agentglass-agent orchestrate --project ~/code/<project>
```

Without `--project` it uses the current directory. It is idempotent: if that
project already has somebody in its chair, you get that agent back rather than
a second one.

The answer names two files. Both are markdown, both live outside the
repository, and both are read fresh every seating:

- **the doctrine** — the rules the SEAT runs by
- **the brief** — the rules it hands to every agent it opens

They are seeded from a template the first time and then they are yours. The
answer says `doctrineSeeded: true` when this call created them, which is your
cue to read them and change what does not match this project.

## One that is already running

If a session has been orchestrating a project for hours — with agents
reporting to it and a context worth keeping — do NOT seat a new one. It adopts
itself from inside its own pane:

```bash
agentglass-agent adopt --project ~/code/<project> --powers assign
```

Nothing restarts, nothing is re-prompted, and no context is thrown away. What
it gains is the app knowing who it is: its line in the view, the queue, the
field drawn for it with the last hour of every agent, and being woken when
that field changes instead of keeping a clock of its own. Its rules files are
seeded if missing so there is something to edit; they are not imposed on it.

Standing down an adopted seat releases the claim. It does not kill the
session — that would be throwing away somebody's day because a button said
"stand down".

## What it may do

`--powers speak` (the default), `nudge`, or `assign`.

| | speak | nudge | assign |
|---|---|---|---|
| read the field, report | yes | yes | yes |
| prompt an agent already running | no | yes | yes |
| start and stop named agents | no | no | yes |

This is a credential, not a sentence in a prompt: a seat set to `speak` is
refused by the server if it tries to prompt somebody. Start at `speak` for a
day. Give it `assign` when its reports have been true.

No level can push, open a pull request, comment, merge, or reach anything
outside the machine.

## Asking it things

```bash
agentglass-agent say "<one line>"          # the seat's own report for this round
agentglass-agent recall "<a question>"     # what this person already decided
agentglass-agent claim <task-id> --to <agent>
agentglass-agent finish <task-id> "<what came of it>"
```

`recall` answers out of the precedent bank, and says so plainly when it has
nothing rather than inventing a precedent.

## The queue

Work is added from the Orchestrator view, and every item carries **what would
prove it done** — a test, a file, an output. An item with no stated proof is
allowed and drawn as missing, because a made-up proof is worse than an
admitted absence. An item that has beaten two agents stops being handed out
and is marked as needing a person.

## What to tell somebody who just made one

1. Read the two files it named. The template is generic; the rules that make
   an orchestrator good are the ones about THIS project.
2. Leave it on `speak` until its line is worth reading.
3. It is woken when the field changes, not on a clock. It does not need a loop
   and should not be given one.
