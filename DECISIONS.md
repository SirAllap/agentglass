# Decisions taken without asking

## The board is scoped to you, and that is not a filter
Yours plus review-requested. "Mine" and "Needs my review" were two mutually
exclusive pills, so the two populations you care about could never be on screen
together. Everything else stays a table behind its own pills.

## The stake comes from which list a PR arrived in
`viewerRequested` is on `PrDetail`, not `PrSummary`. Asking per card would be one
request per row behind a view whose promise is a glance. The `mine` and `review`
scopes are calls the panel already makes to number the pills, so membership in
them IS the stake. The board costs what the pill row cost.

## No "nudge" and no "update branch" on a card
agentglass cannot poke somebody on GitHub, and a button that looks like it can is
worse than none. How far behind a branch is does not travel on `PrSummary`, so
offering it would mean the per-card request the board exists to avoid.

## The task link is provider-neutral, and silent by default
`cardRef` reads a ClickUp card and says so. `taskLink` reads "the work item this
came from", whoever tracks it, and returns null when nothing does — no chip, no
gap. An id in a branch name is a convention half the trackers share, so it shows
only when something is connected that could resolve it. An address is certain and
opens without credentials, so that one always shows.

## The rail refuses to guess
A full path counts as naming a file; a bare `index.ts` does not. Bots are left
out. A check carries a name and no log, so "this check blames this file" is only
said when the check's own name really does. Missing a mention costs the trip you
were already making; inventing one puts somebody else's argument beside your code
and you will believe it.

## One file in the middle column, as a preference
It is what makes the three columns three columns. Kept as a toggle because the
stack is better for reading a small pull request end to end.

## The rail's queued section renders only when it is given drafts
"You queued nothing on this file" and "this caller holds no review" are different
answers, and a section that cannot tell them apart is a section that lies once a
month. Absent prop, absent section; present prop, always rendered including its
empty state — the whole premise is that you cannot otherwise tell.

## `RailDraft` is declared by shape, not imported
A library the rail calls has no business importing the six-thousand-line
component that draws it. `DraftComment` is structurally assignable, so nothing is
cast. If the duplication ever bites, the fix is to move `DraftComment` down here
and re-export it from the panel — not to import upward.

## Loading softens every empty claim, not only the one that was reported
A flag that silenced "nothing in the conversation" while "nothing is failing" and
"no threads" kept asserting would read as a bug rather than as a policy.

## No jump-to-line from a rail thread
Nothing in the panel exposes a scroll-to-thread API, so every jump goes to the
Conversation tab. A button that lands you in the right tab is honest; one that
claims a line and does not reach it is not.

## "No push in 30 days" became "30 days without a push or a comment"
`updatedAt` is GitHub's last-touched-by-anything. Everything counted really has
had no push — a push would have moved it — so the number is a floor and never an
invention. Calling it a push count would be a claim about a fact `PrSummary` does
not carry.

## Staleness is scoped to the board, and says "of these"
The other few hundred are not loaded; that is the board's whole bargain. The
mockup's "41 of 392" could only have been made up.

## No sweep button, and a test says so
There is no API behind one. The absence is locked by an assertion rather than
left to be re-added by somebody who remembers the mockup.

## A wrong `total` drops the number rather than clamping it
When `total < involved` the board is provably being lied to — the two lists it
holds are the evidence — so the sentences drop the number instead of clamping.
A clamp is how "the other 0 are a table" shipped in the first place.

## The lane cap stayed at 6 after the columns learned to scroll
The cap is what keeps the board a glance. Scrolling made it survivable, not
unnecessary.

## A second door beside `openPrs`, rather than teaching it to be clever
`openPrs` sends a search on purpose, and most of its callers are right to use
it: they hold a string — a branch name off a notification, a card id — not an
identity. Making it detect "this looks like a number, open it instead" would
make every caller's behaviour depend on what the user happened to type.

So the chip, which holds both the number and the repository, gets `openPr`,
and the shell turns that into the panel's own jump. The two doors are named
after what the CALLER knows, which is the only thing either of them can be
sure of.

## No git that writes in a worktree three agents are sharing
A `git stash` here took every uncommitted file in the tree — two subagents'
work and mine — in one command. Recovered from `stash@{0}`, but the rule that
came out of it is: in a shared worktree, undo by rewriting the file, never by
asking git to restore the tree. Staging stays per-path for the same reason.

## The rail asks GitHub's question before CI's, in the panel's own words
"Will it merge" and "are the checks green" are different questions, and the
rail was only asking the second — which is how `mergeBlockedWhy`, a function
whose whole job is to explain a block, got asked about a pull request that had
none and answered with its last resort.

The ladder is the panel's, copied rather than improved on. The rail's last
line calls itself the short version of the box in Overview; a short version
that reaches a different verdict is a second opinion, and two boxes disagreeing
about whether you may merge is worse than either being slightly clumsy.

Red **and** CLEAN gets its own sentence rather than being folded into either
side. It means GitHub is not requiring those checks, which is a fact worth
having: it is the difference between a button you should not press and one you
can.

## B8: the rail folds away and nothing moves to Overview
The mockup's CSS is `@media(max-width:1180px){.rail{display:none}}`. Its
footnote says the four sections "move into Overview". They contradict each
other, and the CSS is what it DRAWS — the footnote is a sentence about a
version that was never built.

Deciding for the CSS, and not only because it is cheaper. Every one of those
sections is about "this file", and Overview has no file: doing it literally
means Overview quietly speaking about whichever file Files last had open, which
is the class of quiet wrongness this rail was written to avoid. Below 1180 the
three columns cannot all be honest, so the diff gets the width and the sections
stay in the tabs they came from.

## The strip goes to the mockup, including where I would have chosen otherwise
He asked for pixel perfect and the mockup is the contract, so:

- CHECKS says `44/45 running` rather than "2 checks passed, 3 checks still
  running". The strip is one line with nine cells; the sentence belongs in
  Overview, where there is a paragraph to put it in. Red still NAMES the failing
  check — the mockup's sample has no red, so there is nothing to diverge from,
  and a name is what stops you opening the browser.
- REVIEW prints its zeros. A cell that changes length as the numbers change is
  harder to scan than one that is always the same shape, and the mockup shows
  all three.
- LABELS is plain uppercase text parted by `·`, not coloured chips. This is the
  one I would have kept as it was — a label's colour is chosen in GitHub and is
  how people recognise it — but the strip is nine cells that must read alike,
  and he chose a design where they do. The names are still the names.

## The markdown was parsed; it was the drawing that lost it
Worth recording because the first diagnosis was wrong and cost a subagent an
hour. "Our markdown is bad" reads as a parser problem, and the parser was fine
in both renderers. What was broken was one missing CSS declaration
(`list-style`, undone by a framework reset and never put back) and one join
character. Neither can fail a parse test, and neither shows in any snapshot the
suite had.

Two things follow. A pull request's prose does NOT go through
`web/src/lib/markdown.tsx` — it goes through `web/src/lib/prBody.ts` and the
`.agx-md` stylesheet that lives inside `PrPanel.tsx`; that stylesheet is a
template literal, so a backtick in one of its comments closes it and the build
fails with a CSS line reported as a TypeScript error. And when the complaint is
about how something LOOKS, the measurement is `getComputedStyle` in the built
app, not the source of the renderer.

## A percentage max-height needs a containing block with a height
Written down because it cost two bugs in one day, in opposite directions.

The one-screen review's three columns were given `max-height: 100%`. It works
for the diff and the rail — their parent row carries `h-full` — and it silently
does nothing for the file tree, which is `position: sticky` inside the diff's
scroller and therefore sits in a content-sized flex row. CSS resolves a
percentage against one of those as `none`, so the tree grew past the window with
no scrollbar and the end of a long tree could not be reached.

Measured rather than reasoned, in both directions: forced to 2252px the tree
reported `scrollHeight === clientHeight` and a bottom edge at 2584 against a
617px window; with a viewport cap it reports max-height 457, scrollHeight 2252,
scrollable. The lesson for the next column: a percentage height is a question
about the parent, and the answer is only visible in a browser.

## An allowlist is not the whole attack surface
The inline-HTML allowlist added today was argued safe by construction, and it
is — a security round threw entity double-decoding, attribute smuggling on
allowlisted tags, protocol tricks and a 50,000-case structural fuzz at it and
none of it got through.

The hole was ten lines away, in code nobody had changed: an href interpolated
raw into `href="…"`. A URL may legally contain a double quote, so a crafted
markdown link closed the attribute and named its own, and the bare-URL pass then
re-matched the `https://` inside the anchor that had just been written and ate
the closing quote on its way out. Proven by loading the output as `innerHTML` in
a real browser and dispatching the event.

The rule this leaves: when a review says "is the new thing safe", the answer has
to cover every place the same output is CONSTRUCTED rather than escaped —
attributes first, because an attribute is where text becomes syntax. And the
test for it asks a real HTML parser what elements and attributes came out, not a
regex what the string looks like.

## Two copies of a sentence become two different sentences, within the day
Three findings in one audit round were the same shape: a fact computed in two
places. The merge verdict lived in Overview and, copied, in the rail — and the
copy that carried a comment saying "a short version that reaches a different
verdict from the long one is not short, it is a second opinion" was, by then,
a second opinion on two of three cases. The check sentence was fixed in the
field strip and not in `checksLine`, so a cell disagreed with its own tooltip by
five checks. And `namedOnlyInRoster` re-derived what `railScan` had just been
made to own, so changing the rule would have changed the app while the test kept
passing on the old one.

None of the three was a mistake at the moment it was written; each was correct
and then the other copy moved. So the rule is not "do not duplicate" — it is
that a fact with two producers has no owner, and the fix is always the same
shape: one function, and the surfaces differ only in how much room they have to
print what it says.

## The loop stops here, and it stops because the returns turned
Rounds one and two paid for themselves several times over: a stored XSS proven
to execute in a real browser, the black screen unfixed at its source, "could not
ask GitHub" drawn as "no pull request", and twenty-one milliseconds of blocking
on every keypress in the file tree. None of that was visible by reading.

Round three found one real bug — list depth from dividing the indent, which
nested a four-space sublist inside a two-space one — and then started asking for
code that works to be moved so it could be tested. That is where the risk
crosses over, and he called it: "si seguir iterando va a romper código ya hecho,
mejor para ya".

What is left behind is deliberate, not forgotten. Every unclosed finding is in
TASKS.md with the exact mutation that proves it, so the next person does not
have to rediscover which tests are load-bearing. And the two lines that made the
panel untestable — a module-scope `location` read and a store with no server
snapshot — are fixed, so the door is open without anyone having to walk through
it today.
