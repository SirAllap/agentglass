# Orchestration · Flow

Settings > Orchestration is where a project's setup is read and edited: a pinned
region — the page header, the project row and the scope bar — then the hero (the
orchestrator and its mode, the path drawn as one row of discs, the plan used,
the workers in flight and today's cost, and the page's one primary action, the
Flow editor), then ONE scrolling region with two sections: **Safety and limits**
and **Always refused**. The presets a person can save, share and import are
behind the hero's **Presets** chip, not in the page body. The block menu and the
keys are not on the page: this document is their reference, and the Flow editor
draws them. Polaris is a page of its own in Settings > Agents, beside this one,
and the page keeps only the pointer to it.

Safety and limits is, in order: the three levels (Cautious, Balanced, Open), the
limits and what happens at one, what a worker may do by default beside the most
the main agent may allow, the agents' own switches (the trust switch and the
Gate) beside what is never in a worker's hands, and **Extra shell commands**
(docker, one switch over the default and the most allowed, and the commands
nobody may have). Every limit carries the one line that says what its number
means. A reading the page does not have is a sentence — "Not connected", "Not
read yet" — never a dash that reads as a measurement; the line under today's
cost names the block that settled and when, never the message a worker wrote.
There is one save bar for both sections, and it is drawn only while something
is unsaved.

## The Flow editor

The full-screen editor draws one card per step of the project's path: the step's
number and stage, the chain it runs on, the tries its own failing arrow allows,
the live count the board reports, and **one** Configure. Configure, `Enter`, a
double-click and the card's menu all open the same worker editor, which is the
only place a worker is configured; the panel on the right is a read-only summary
and says so. Its sections are Who does the work, Prompt, What happens next, What
it may do, Who checks this, Rules that move it, and Name and look (folded for a
worker that already exists, open while adding one). **Add worker** opens it
empty, and a gap's `+` or the card's "Add a step after" opens it at that place.

What it may do holds the role's tools, Reads only, and, under them, the
commands it may run that every worker is otherwise refused — one prefix per
line, `docker` or `make deploy`. The list reaches that role's workers only;
every other role keeps the lock. The save is refused, with the command named,
for one no role may ever be granted: `git push`, `gh`, `ssh`, `scp`, `sudo`,
`rm` and the signal senders stay a person's.

## The orchestrator's card and sheet

Above the path sits the orchestrator's card: the engine and model the policy
gives it, who is in the chair, workers flying now (`n of` the policy's
`limits.maxWorkers`), what the plan has spent, today's cost, the board's last
line, and the roles waiting in the team. **Configure** opens its sheet — engine,
model, the Flight plan's pilot (`flightPlan.pilot`, whose autopilot answer no
agent may set) and the most it may grant a worker (`ceiling`) — and every control
there saves at once. **Open its tab** brings the seat's own session forward, and
is drawn only while somebody is seated. What the orchestrator does with code is
set on the reviewing block, not in this sheet: it has one home.

## The block menu

Every block in the drawing opens the same menu: right-click it, press the menu
key, or `Shift`+`F10`. Each entry is in the page's menu registry
(`web/src/components/orchestration/flow/flowCopy.ts`, `FLOW_MENU`) with its own
id, so the same action reads the same on every block. A test fails if a block
loses one.

| Item | Does |
| --- | --- |
| Open details (`Enter`) | selects the block and opens This block |
| Change engine… | opens This block on the engine row; off on a block with no engine row (You, the Gate, the Fallback) |
| Change model… | opens This block on the model row; off on a block with no model row |
| Add a step after | off: the chain is six stops, and a rule changes who runs a stop rather than adding one |
| Use the general setting | only where a project has a setting of its own; drops it |
| Copy settings as text | the block's engine, model, hand-off and limits, for a task or a doc |
| Remove step | off: the six stops stay; turn a rule off or pick another engine |

## Keys

The drawing's keys are in the page's own list (`FLOW_KEYS`) and this document is
where they are printed: the page no longer carries a Keys and menus section. The
up and down arrows are drawing-only: they exist on Scout and the Fallback and
are not in `FLOW_KEYS`.

| Key | Does |
| --- | --- |
| `←` `→` | previous / next block in the ring: Scout, then the chain, then Fallback |
| `↑` `↓` | drawing-only: between Scout, the Builder and the Fallback |
| `Enter` | opens the focused block |
| `Shift`+`F10` | the block's menu |
| Menu key (`≡`) | the block's menu |
| `Alt`+`1`–`2` | Safety and limits / Always refused |
| `Esc` | closes a menu |

Nothing here is a hidden gesture: a right-click, the menu key and `Shift`+`F10`
open the same menu in the same place, and the arrow keys move focus between
blocks rather than scrolling the page.

## What a change does

Choosing an engine, a model or a rule saves at once (there is no Save in the
panel). The block in the drawing then carries a **changed** mark for this visit
and its chip already reads the new engine, because both the chip and the panel
are drawn from the policy the server holds. The mark is cleared by the panel's
own button or by leaving the page.

**Who reviews and checks**, the round cap on the loop and the second reviewer
are three settings kept per project (`orchestration.review.who`,
`orchestration.review.rounds`, `orchestration.review.second`). They save at
once, the loop's label follows the cap, and the chair's standing instructions
carry the answer the next time it is seated. An engine the second reviewer
points at that cannot take a worker role here is named, with **Show it**
opening Agent engines.
