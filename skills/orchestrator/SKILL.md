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

What the agents in the project may do is the project's rule list, not the
chair's memory: `agentglass-ui rules list` reads it, and a rule the person
tells the chair in chat is written with `agentglass-ui rules set` (stricter
applies at once, looser waits for the person). See the ui-control skill.

## Asking it things

```bash
agentglass-agent say "<one line>"          # the seat's own report for this round
agentglass-agent recall "<a question>"     # what this person already decided
agentglass-agent claim <task-id> --to <agent>
agentglass-agent finish <task-id> "<what came of it>"
```

`recall` answers out of the precedent bank, and says so plainly when it has
nothing rather than inventing a precedent.

## Opening agents

Through the app, never with a bare `tmux new-window "cli ..."`: a CLI that
exits 0 closes that tab and takes its output with it.

```bash
agentglass-agent start <name> --role builder --cwd <worktree>   # a seat starts agents with a role, in its own project
agentglass-agent read <name>                                    # its answer, while the kept tab is there (a day)
agentglass-agent stop <name>                                    # close the kept tab once it is read
agentglass-agent own <name>                                     # take an agent nobody owns (an enlisted tab in this project) before you use it
```

A seat has no role-less start: the role is where the envelope comes from, and
the directory has to be inside this project or one of its worktrees. Both are
refused with a sentence that says so.

The person can set the policy in one click with **Quick setup** (Settings ▸
Orchestration): it adds a rule whose id starts with `preset-`, and only the
person can apply it or take it back. Leave those rules to them; to see what the
policy would do right now without starting anything, read `GET /orchestration`
and `GET /orchestration/state`.

## Starting a worker through the policy

```bash
agentglass-agent start <name> --role builder --cwd <worktree> --prompt "<the task>"
agentglass-agent start <name> --role builder --cwd <worktree> --engine opencode --model opencode/big-pickle
agentglass-agent start <name> --role builder --cwd <worktree> --allow commit
```

Where the person has set an orchestration policy (Settings), `--role` starts
the engine the policy says for that role, headless: one turn in a tab, with an
exit code. The result says `{engine, model, because, envelope}`; read `because`.

- **The policy decides the choices.** `--engine` and `--model` must be an entry
  of the role's chain, and the engine must be ready on this machine. Anything
  else is refused with the chain in the sentence. You cannot edit the policy.
- **The envelope starts narrow**: its own worktree, no network, no commit.
  `--allow network` or `--allow commit` widens it by one thing, only up to the
  project's ceiling. Pushing, posting, merging, publishing and spending are not
  something an envelope can hold: they are the person's, always.
- **A worker is stopped, not steered.** It cannot be told something in the middle
  of a turn. When its turn has ended (`wait <name> --until gone`, then `read`),
  `prompt <name> "<next>"` starts the next turn on the same engine, resumed.
- **A turn has a limit** (Settings ▸ Orchestration, 30 minutes unless changed). A
  worker still running at it is stopped with everything it started, its row says
  `timeout` (exit 124), and you get one report. If the app restarted during the
  turn, the row's `because` says `ceiling lost: restarted`: that turn is no longer
  stopped at its limit, so check on it yourself and `stop` it if it hangs.
- **A failed FIRST turn may move to the next engine, once.** Only when the engine
  was rate-limited or signed out before it did anything, and never for a role the
  person set to ask. `because` then says which engine it moved off. A failure on a
  later turn, or after work began, is never moved: you get a report and decide.
- **The chair can change engine, and not by itself.** When the policy names another
  engine for your chair, the row gets a `next` and the Lantern offers **Change now**
  to the person. A running chair is never swapped by a rule: the person chooses the
  moment, you write your hand-off first, and the new seat is woken on it.
- **Yours only.** You can prompt, read, key and stop the agents you own: the workers
  you started, and any other agent after `agentglass-agent own <name>`. An agent with
  no owner is refused until you do; one another project's seat owns, never. `enlist` and
  `own` reach only tabs inside this project or its worktrees, and never a seat's own
  chair, yours included. Enlisting a tab under a finished worker's name makes that name
  an ordinary tab: it has no owner and no turn to resume. A worker is refused when it uses the CLI as it is to start workers or seat anything.
- **The lock is partly enforced, on every engine.** It is a list of command rules, not a
  sandbox: the result's `partly` says what it does not catch. Do not hand a worker text
  you would not trust with the person's own shell.
- **When it hits the wall**, it says so in its answer: read it, then widen inside
  the ceiling, change the plan, or raise a need for the person.
- Every start, prompt, key and stop is in the person's Activity log under your
  name, refusals too.

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
