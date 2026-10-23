# Design system

The frontend's canon: the shapes, surfaces and colours a view is built from,
where each one is defined, and the tests that hold the app to them. Every name
here exists in `web/src`, and `web/test/design-system-doc.test.ts` fails the
build when one stops existing — so this page cannot describe a token the code
no longer has.

Nothing here was invented for the page. Each rule is the one the views already
agreed on when they were counted, written down so the next view reaches for it
instead of typing its own number.

## Principles

**One control height ladder.** A control is `CTRL_H.compact` (22) in a row, a
card or a sub-toolbar; `CTRL_H.regular` (28) in a view header, the height of
`CHIP` and `RefreshButton`; `CTRL_H.large` (32) for a text input and a tab
bar. A 24px button from `py-0.5` is off the ladder, and a row mixing it with a
28px chip never lines up.

**One radius per role.** Controls — buttons, chips, inputs, icon buttons — are
`rounded-lg`. Cards, panels, popovers and dialogs are `rounded-xl`. Nothing is
`rounded-2xl`, and nothing spells a radius in brackets (`rounded-[10px]`).
(The pull request conversation's cards draw at `rounded-md` today.)

**One border family, two weights.** `EDGE` outlines a thing — a control, a
card, a dialog. `LINE` is a rule between things — a row separator, a header's
bottom edge, a column's side. A tinted border (primary, warning, error) says
something on purpose and stays what it is; a neutral border that is neither of
the pair is counted by a ratchet and only goes down.

**Surfaces through a token, never a raw colour.** A card, panel, dialog or
popover body is `--surface-card`; a well inside one that takes input (a text
box, a code sample) is `--surface-inset`; the nav is `--surface-nav`; a raised
thing's shadow is `--surface-lift`. `var(--bg2)` painted straight onto a card
looks the same today and does not move when the card level does.

**Tinted text through an ink.** Text in a semantic colour reads
`--success-ink`, `--warning-ink`, `--error-ink`, `--info-ink` or
`--primary-ink`, never the bare tint. `inkTints` derives each one per theme with
`inkFor`, which keeps the tint when it already clears 4.5:1 against `--bg3`,
tries the palette's other ANSI shade next, and only then mixes toward `--text`.
A colour that arrives with the data (a label's hex, a status's hex) goes
through `dataInk`, the same rule measured against the live theme.

**Prose font for what a person wrote, mono for the machine.** The app is set in
the monospace stack from `tailwind.config.js`, because paths, diffs and logs
line up in it. A paragraph somebody wrote — a pull request body, a comment, a
tracker card, a document — reads in `--font-prose`.

**Optimistic for cheap, reversible writes.** A reaction, a ticked checklist
box, a resolved thread or a label moves on the press, before the write answers
(`Optimistic` in `web/src/lib/prOptimistic.ts`). A refusal takes the change
back and says so with a notice; a read that was already in flight does not flip
it back. Anything that cannot be undone by pressing again — a merge, a close —
waits for the answer and shows `pending` in its own button.

**Timelines follow GitHub's shape.** A conversation is one rail with the
entries beside it: the speaker's avatar in a column of its own, OUTSIDE the
card; the remark in a neutral `--surface-card` card; the small events (opened,
force-pushed, review requested) sitting on the rail at a fraction of a
remark's weight. Status — approved, changes requested, pushed — goes on the
rail's node icon, tinted with an ink, not on the card's border or fill. The
geometry is the `TL_*` constants in `web/src/components/workspace/Chrome.tsx`.

## Tokens

The test reads this table: the first column is a name that must be defined in
the file the third column names, and a bare number in the second column must
be its value there.

| Name | Value | Defined in |
| --- | --- | --- |
| `CTRL_H` | compact 22, regular 28, large 32 | `web/src/components/workspace/Chrome.tsx` |
| `EDGE` | 1px, `--text` at 14%: the outline | `web/src/components/workspace/Chrome.tsx` |
| `LINE` | 1px, `--surface-line`: the rule | `web/src/components/workspace/Chrome.tsx` |
| `tintEdge` | a 1px edge tinted by a hue the caller owns: the edge that means something | `web/src/components/workspace/Chrome.tsx` |
| `CHIP` | the control shape: 11px, `rounded-lg`, 28px min height | `web/src/components/workspace/Chrome.tsx` |
| `CHIP_SURFACE` | fill and `EDGE` for a control with no on-state | `web/src/components/workspace/Chrome.tsx` |
| `CHIP_SURFACE_CLS` | its hover step | `web/src/components/workspace/Chrome.tsx` |
| `chipTone` | the one pressed look | `web/src/components/workspace/Chrome.tsx` |
| `CHIP_ICON` | `ICON.md`, an icon inside a control | `web/src/components/workspace/Chrome.tsx` |
| `INPUT` | the text input: 12px, 32px, `rounded-lg`, `--surface-inset` | `web/src/components/workspace/Chrome.tsx` |
| `INPUT_STYLE` | `EDGE` for `INPUT` | `web/src/components/workspace/Chrome.tsx` |
| `GROUP_HEADING` | the heading over a group of rows | `web/src/components/workspace/Chrome.tsx` |
| `Button` | component: push button, tones plain/primary/danger/ok/warn | `web/src/components/workspace/Chrome.tsx` |
| `ButtonTone` | type | `web/src/components/workspace/Chrome.tsx` |
| `IconButton` | component: icon-only header control at `CTRL_H.regular` | `web/src/components/workspace/Chrome.tsx` |
| `IconChip` | component: icon-only control at `HIT` | `web/src/components/workspace/Chrome.tsx` |
| `RefreshButton` | component: the header refresh | `web/src/components/workspace/Chrome.tsx` |
| `Chip` | component: a toggle or one-shot chip | `web/src/components/workspace/Chrome.tsx` |
| `Segmented` | component: a filter set | `web/src/components/workspace/Chrome.tsx` |
| `Tabs` | component: a strip that swaps the body | `web/src/components/workspace/Chrome.tsx` |
| `ScopeChip` | component: what a view is pointed at | `web/src/components/workspace/Chrome.tsx` |
| `FilterField` | component: the filter box over a list | `web/src/components/workspace/Chrome.tsx` |
| `ICON` | xs 12, sm 14, md 16 (default), lg 18, xl 22, rail 26 | `web/src/lib/iconSize.ts` |
| `HIT` | 26 | `web/src/lib/iconSize.ts` |
| `MIN_BOX` | 20 | `web/src/lib/iconSize.ts` |
| `LAYER` | viewer 10020 up to alarm 10300 | `web/src/lib/layers.ts` |
| `COLLAPSE_FROM` | 7 | `web/src/lib/prStack.ts` |
| `MAX_TIERS` | 64 | `web/src/lib/prStack.ts` |
| `--surface-nav` | the nav, leaning to `--bg2` | `web/src/index.css` |
| `--surface-card` | a card, panel, dialog or popover body | `web/src/index.css` |
| `--surface-inset` | a well inside a card that takes input | `web/src/index.css` |
| `--surface-line` | the rule's colour | `web/src/index.css` |
| `--surface-lift` | a raised thing's shadow | `web/src/index.css` |
| `--font-prose` | the sans stack for human prose | `web/src/index.css` |
| `--success-ink` | `--success`, at 4.5:1 or better | `web/src/lib/contrast.ts` |
| `--warning-ink` | `--warning`, at 4.5:1 or better | `web/src/lib/contrast.ts` |
| `--error-ink` | `--error`, at 4.5:1 or better | `web/src/lib/contrast.ts` |
| `--info-ink` | `--info`, at 4.5:1 or better | `web/src/lib/contrast.ts` |
| `--primary-ink` | `--primary`, at 4.5:1 or better | `web/src/lib/contrast.ts` |
| `TINT_KEYS` | the tints that get an ink | `web/src/lib/contrast.ts` |
| `inkFor` | a tint lifted to a contrast target | `web/src/lib/contrast.ts` |
| `inkTints` | writes the `--*-ink` set for a theme | `web/src/lib/contrast.ts` |
| `dataInk` | `inkFor` for a colour that came with the data | `web/src/lib/contrast.ts` |
| `TIER_TARGET` | `--text2` 7, `--text3` 5, `--text4` 4 | `web/src/lib/contrast.ts` |
| `floorTiers` | lifts the text tiers to their targets, in order | `web/src/lib/contrast.ts` |
| `TL_AVATAR` | 40 | `web/src/components/workspace/Chrome.tsx` |
| `TL_GAP` | 12 | `web/src/components/workspace/Chrome.tsx` |
| `TL_RAIL` | 16 | `web/src/components/workspace/Chrome.tsx` |
| `TL_SPACE` | 16 | `web/src/components/workspace/Chrome.tsx` |
| `TL_INDENT` | `TL_RAIL * 2 + 4` | `web/src/components/workspace/Chrome.tsx` |
| `TL_CSS` | the `agx-tl` timeline rules, for a view's own `<style>` | `web/src/components/workspace/Chrome.tsx` |
| `TONE_COLOR` | a plugin's tone as a fill, a stroke or a dot | `web/src/lib/pluginTones.ts` |
| `TONE_INK` | the same tones for text, through the `--*-ink` set | `web/src/lib/pluginTones.ts` |
| `PILE_MAX` | 4 | `web/src/lib/canvasGeometry.ts` |
| `ENTER_MS` | 180 | `web/src/lib/canvasMotion.ts` |
| `EXIT_MS` | 160 | `web/src/lib/canvasMotion.ts` |
| `FLIP_MS` | 220 | `web/src/lib/canvasMotion.ts` |
| `TRAVEL_MS` | 600 | `web/src/lib/canvasMotion.ts` |
| `CANVAS_FLOW_MARKS` | 3 | `shared/pluginCanvas.ts` |
| `DIAL` | 56 | `web/src/components/plugins/PluginCanvas.tsx` |
| `PIP_MAX` | 40 | `web/src/components/plugins/PluginCanvas.tsx` |
| `CanvasGlyph` | component: the fixed icon words a live canvas may name | `web/src/components/plugins/panelGlyph.tsx` |
| `BoardView` | component: a plugin's board, one machine behind glass | `web/src/components/plugins/CanvasBoard.tsx` |
| `BOARD_SCALE_MIN` | 0.6: under it the board keeps 0.6 and scrolls | `web/src/lib/canvasGeometry.ts` |
| `BOARD_SCALE_MAX` | 1.6: a small board on a wide screen stops here | `web/src/lib/canvasGeometry.ts` |
| `SLOT_H` | 22 | `web/src/lib/canvasGeometry.ts` |
| `SLOT_GAP` | 4 | `web/src/lib/canvasGeometry.ts` |
| `SEALED_SLOT_H` | 14 | `web/src/lib/canvasGeometry.ts` |
| `RIDE_GAP_MS` | 220 | `web/src/lib/canvasGeometry.ts` |
| `RIDE_LATE_MS` | 1200 | `web/src/lib/canvasGeometry.ts` |
| `rideClearMs` | the measured spacing that keeps two rides a token apart | `web/src/lib/canvasGeometry.ts` |
| `FLOW_BUSY_MS` | 1100 | `web/src/lib/canvasMotion.ts` |
| `SETTLE` | `cubic-bezier(0.23, 1, 0.32, 1)`: enters and exits alike | `web/src/lib/canvasMotion.ts` |
| `MARK_MS` | 1200 | `web/src/lib/canvasMotion.ts` |
| `DIAL_W` | 66 | `web/src/components/plugins/CanvasBoard.tsx` |
| `STRIP_MAX` | 3 | `web/src/components/plugins/CanvasBoard.tsx` |
| `MECH_MIN` | 0.4 of a mechanism's size, when its part is crowded | `web/src/components/plugins/CanvasBoard.tsx` |
| `ODO_MAX_DIGITS` | 10 | `web/src/lib/canvasGeometry.ts` |
| `trimStart` | a ride's route, less half a token at its start | `web/src/lib/canvasGeometry.ts` |
| `--bd-plate-a` | a part's plate, light at its top edge; each `--bd-*` is a house token through color-mix | `web/src/components/plugins/canvasBoard.css` |
| `--bd-steel` | the dark metal: posts, jaws, bezel, knob, step disc | `web/src/components/plugins/canvasBoard.css` |
| `--bd-lit` | the machine's light: `--success` 55% into `--info` (teal from house tokens) | `web/src/components/plugins/canvasBoard.css` |
| `--bd-lit-ink` | `--bd-lit` toward `--text`, for a word that glows | `web/src/components/plugins/canvasBoard.css` |
| `--bd-light` | the hot core of that light, `--bd-lit` toward white | `web/src/components/plugins/canvasBoard.css` |
| `PluginNotRunning` | component: what a panel says when its plugin is down | `web/src/components/plugins/PluginNotRunning.tsx` |

The `--*-ink` variables have no line in a stylesheet: `inkTints` writes one for
each entry of `TINT_KEYS` when a theme is applied, so the test checks that the
tint is in `TINT_KEYS`. The spacing scale and the type sizes are declared in
`web/tailwind.config.js`.

## Components to use

Reach for these before writing a `<button>`, an `<input>` or a colour:

- A push button is `Button`, at `size="compact"` or `"regular"`, in a `tone`.
  Not a `<button>` with its own padding, radius and border: four of those grew
  four heights and four radii before they became thin wrappers over this one.
- An icon-only control in a header is `IconButton`; `IconChip` where the square
  must be `HIT`. A glyph is an icon component at an `ICON` rung, never a typed
  `×` or `⋯`.
- Refresh is `RefreshButton`, icon-only, with the word in `title`.
- A set of filters is `Segmented`; a strip that replaces the body is `Tabs`
  over a `tabpanel`. A box drawn around either says nothing the tint does not.
- A toggle chip is `Chip`; what a view is pointed at is `ScopeChip`.
- A text input is `INPUT` with `INPUT_STYLE`; the filter over a list is
  `FilterField`.
- Borders are `EDGE` or `LINE`; fills are `--surface-*`; tinted text is a
  `--*-ink`; a stacking order is a `LAYER` entry.
- A conversation or history is the `agx-tl` timeline in `Chrome.tsx`, used by
  `PrPanel.tsx`, `TasksPanel.tsx` and `ChatPanel.tsx`, not a new list of
  bordered cards.

A view that needs something these cannot express adds it to `Chrome.tsx`,
where the next view will find it, and adds its row to the table above.

### The pull-request card on the triage board

One surface. The identity line carries the forge's mark, the number that copies
itself, the author and age, and, at its end, a 28px tracker block: the work
item's mark, its id as a button that opens it inside the app, its status in the
shared `StatusPill` (never truncated, dimmed with its age when stale) and up to
five faces, then `+N`. The block is drawn per repository: a repository that
links no work items gets the plain pull-request card, with nothing reserved and
no hint; one that does, and a pull request without a card, gets the same box
with a quiet "No card linked". When the line cannot hold the block it takes a
line of its own, right aligned; in a lane narrower than the block it wraps onto
a second row rather than overflow.

The header band above the identity line says what a person decided, in a 22px
row that never wraps. At its right it draws one 16px face per person (8px apart) the pull
request is waiting on or has heard from: up to three, then a `+N` pill whose
tooltip lists the rest, every face titled "login — state". A 1.5px ring
outside the face says the state (amber solid: asked to look again; grey dashed:
asked and not answered; red: changes requested; green: approved; grey solid:
commented) and an `ICON.xs` badge at its corner repeats it by shape, so the
colour is never the only cue. Faces sit before the open-threads pill and the
arrow, which do not move. The decision (who, which state, in which order, and
the "Waiting on N reviewers" sentence for two or more) is
`web/src/lib/cardReviewers.ts`; when and how many threads each person has open
stay in the pull request's own page, because the list does not carry them.

The two copy buttons (card id, card name) live in a 56px box inside the block
and replace the faces on pointer-over or focus-within, so nothing moves; with no
hover (coarse pointer) they take an inline slot. Under them: the title (cut
after three lines, two when wide) with the link and the star at `HIT`; where it
stands (a word, the base, the label and the diff on one wrapping line, a 3px bar;
colour only on the checks); what happened last. One footer: Open at the left,
who is on the pull request at the right, in the same place in every state.

The card measures itself (`container-type: inline-size`, `.agx-prc`): from 760px
the standing zone and the footer become a 352px right column and the link and
star move up to the identity line. Which block a card gets, and the per-repository
rule, live in `lib/prCardBlock.ts`; the wording of each zone in
`lib/prCardZones.ts`; both with tests.

### A stacked pull request

A pull request that targets another open pull request's branch is drawn as part
of a stack, in three places and no new row (`StackMarks.tsx`, with the decision in
`lib/prStack.ts` and the words in `lib/prStackWords.ts`).

- **The spine** is one numbered box per open tier down the card's left edge,
  inside its padding (5px in, 16px wide, 2px apart, never under `MIN_BOX` tall,
  so a 6-stack card is 140px). The same boxes on every card of the stack: solid
  is this card, tinted another one on the board, dashed one that is not on it.
  A base that is gone is drawn and never counted: a drawn tick for merged, a
  drawn cross for closed, `?` for a branch with no pull request. From
  `COLLAPSE_FROM` tiers up the middle is a count (`+3`). A card's content starts
  12px further in; that is the whole cost of the mark besides the box heights.
  The boxes are decorative at 16px, so the spine is an `img` with the sentence
  as its name and the token is the target.
- **The token** replaces the base branch in the stand line: `MIN_BOX` tall,
  `#1180 · ready to land` and a caret, pressing it opens that pull request inside
  the app. The word is the tracker card's status when the app already holds it,
  else the column the base sits in (also for a filtered-out one), else its state.
  Dashed is a base that is not on the board, orange a broken stack. Where the
  base cannot be opened it is the branch name, plain.
- **The control** is three fixed slots after the number in a pull request's
  header, 150px: previous (the base), the identifier with mini boxes and
  `2 of 3` (opens the ladder), next. A missing neighbour keeps its slot, dimmed,
  so stepping moves nothing. The ladder is a popover of `agx-menu` over the
  branch row: the trunk, each rung with its checks, review and word, `you are
  here`, a dashed rung for a missing base. The branch field carries the same
  token.

Colour is a family (`--c`, `--ci`) from the house tints and never the only
signal: every mark has a word, a number or a drawn glyph, and a sentence.

## A plugin's live canvas

`PluginCanvas.tsx` draws a scene a plugin changes many times a second
(`shared/pluginCanvas.ts`). In the flow layout it is built from the same parts
as everything else and adds no colour, radius or surface of its own; what it
decides is layout and motion. A `board` is the one place with materials of its
own, and they are still house tokens (below).

- **Layout is the app's.** The root fills the panel's width. A lane is a card
  (`rounded-xl`, `--surface-card`, `EDGE`) that lays its children out by
  `layout`: a list, an auto-fill grid, or a pile that shows `PILE_MAX` and says
  "+N". Nothing is positioned by the plugin, so nothing overlaps.
- **Colour is a tone.** A tone is a word looked up in `TONE_COLOR` (fills,
  strokes, dots) or `TONE_INK` (text, so it clears 4.5:1). A tinted chip is a
  ring (`inset 0 0 0 1px`), not a border, so the border ratchet does not count
  it.
- **Icons are a fixed list.** `CanvasGlyph` draws each word of `CANVAS_ICONS`
  at an `ICON` rung; the table is typed over the whole list, so a word added to
  the contract without a drawing does not compile.
- **Controls are the house ones.** A button is `Button`; a segmented control is
  a `radiogroup` of `CHIP`s; a disclosure is a native `<details>` with the text
  in a `<pre>`. Nothing renders Markdown.
- **Motion is `transform` and `opacity` only**, through the Web Animations API:
  enter `ENTER_MS` and exit `EXIT_MS` (shorter), both on `SETTLE`, FLIP `FLIP_MS`, a ride along a wire
  `TRAVEL_MS` unless the plugin asks for less. Marks on a `flowing` wire are
  `CANVAS_FLOW_MARKS` small dots translated along the route (a dashed stroke
  animated with `stroke-dashoffset` would repaint every frame). The one CSS
  loop is `agx-canvas-pulse`, 1.6s a cycle and an opacity dip to 0.55.
  At most `CANVAS_LIMITS.tweens` one-shots run at once, past that a change is
  applied instantly; a loop runs only for the ids `loopingIds` allows.
  Everything pauses while the window is hidden or the canvas is off screen,
  and under `prefers-reduced-motion` durations are 0, nothing loops and the
  scene still updates.
- **Wires are drawn above the layout**, in one overlay that takes no pointer,
  routed by `routeEdge` from the rectangles the nodes measure (kept in refs; a
  scene id never reaches a selector).

### A board

`BoardView` (`CanvasBoard.tsx`, `canvasBoard.css`) draws a stage of `w` x `h`
board units, scaled uniformly to the panel's width between
`BOARD_SCALE_MIN` and `BOARD_SCALE_MAX`; under the floor it keeps 0.6 and its
own wrapper scrolls, because a 1180-unit machine below that has labels under
7px. Nothing in it is laid out by measuring: a `part` is placed by its props,
a trace follows its `points` (or an elbow between the centres of the parts at
its ends, `boardRoutes`), and the whole thing scales together, so nothing
inside can come to overlap text at another width.

- **Layers, bottom to top**: the ground (a 24-unit grid and etched lines seeded
  from the board's id, `etching`), the traces, UNDER the parts, the parts, a
  riding token (lifted by z-index), and the glass (edge, sheen, glint, four
  screws), which takes no pointer. `material: plain` drops the ground and the
  glass and draws the slab as a house card.
- **Materials are derived.** Every `--bd-*` is a house token through
  color-mix, on the canvas root, so every shipped theme gets its own machine.
  The window marks a dark theme with `data-scheme="dark"` by the app's own rule
  (the luminance of `--bg`), and dark is designed: a graphite ground, plates
  of the raised tone at low alpha with a lighter top edge, light in the traces.
  Borders are rings (`inset 0 0 0 1px`) and an empty slot is a dashed outline,
  so the border ratchet counts none of them.
- **Light is `--bd-lit`, not `--primary`.** Everything that glows — a trace
  and its marks and joints, a lit pip, a full slot, the scanner, the core's
  ring and pulse, a ring countdown, an `accent` needle or pill, the glass's
  edge — is green mixed into blue from the theme's own tokens. The default
  themes have a neutral grey `--primary`, and a machine lit in grey reads as
  switched off. `--primary` is kept for focus and selection, and a tone
  `accent` inside a board means `--bd-lit`.
- **Depth reads as thickness.** A part's `depth` (0-4) lengthens its shadows
  in three stepped layers with negative spread, plus a 1px ring; the core, the
  deepest, reads thickest. A header is a step disc, the title in small caps at
  +0.09em, and the hint on the right.
- **Big numbers** are tabular, weight 700, at -0.02em. An odometer rolls at
  most `ODO_MAX_DIGITS` cells, each one strip of ten digits as a single text
  node; a longer number is written as text.
- **The panel keeps its scrollbar's room** (`scrollbar-gutter: stable`): the
  board scales with the width, and a scrollbar arriving would move everything
  under the board.
- **A bay** has `cols` x `rows` fixed slots, `SLOT_H` tall with `SLOT_GAP`
  between (`SEALED_SLOT_H` sealed). Tokens fill them in scene order; past the
  last slot, that slot says "+N" (`baySplit`), so two tokens never share one. A
  token in a bay does not slide when the slots shift: diagonal paths across a
  grid cross. A token directly in a part sits in one centred strip of
  `STRIP_MAX`.
- **A mechanism takes its part's free band** (gate, press, core): the height
  its part's column leaves between what the plugin put above it and below it.
  Inside that band it is centred on the PART's centre, where a trace between
  part centres runs, as far as the band allows; a band too short shrinks it,
  down to `MECH_MIN` of its size, rather than let it slide under text. A bay
  in a part with a mechanism is drawn ON the mechanism: a token sits between
  the blades, between the jaws, on a core's right rim (the face holds text, and a
  token landing lower crossed it).
  A token in a bay keeps a chip's width however wide its slot.
- **Rides** follow the trace in board units. On one trace a ride starts at
  least `RIDE_GAP_MS` after the last one started, and more when `rideClearMs`
  measures that the last token has not cleared its own width by then (a short
  trace with a curve that starts slowly); a ride that would wait past
  `RIDE_LATE_MS` lands in place. A waiting ride is invisible until it leaves,
  and a ride leaves from the part's edge (`trimStart`), not centred on it. The
  spacing runs on the main thread, so it is decided after the cheap refusals
  (reduced, hidden, budget full, already late), reads a sampled curve and is
  cached; a ride the budget refuses does not take the trace's turn.
  Two traces that meet at a point are not spaced against each other: that is
  the plugin's choreography.
- **Interruptible state is a transition**, never keyframes: a gate's blades, the
  lever's knob, a needle (a slight spring), an odometer's cells. Enter curves
  are `cubic-bezier(0.23, 1, 0.32, 1)`; a press is `:active` scale 0.97 in
  120ms, and hover exists only under `(hover: hover) and (pointer: fine)`.
  The loops (a busy core's ring and pulse, a busy press, a trace's marks, one
  faster mark every `FLOW_BUSY_MS` on a busy trace) run only for ids
  `loopingIds` allows, and pause with the canvas.
- **A change from the keys is not animated**: the lever's knob snaps when an
  arrow key moves it and slides only for a pointer press.
- **Nothing is said by colour or by a cut-off alone.** A truncated title, hint
  or token label carries its whole text as its name and its tooltip; a closed
  gate says "closed"; a lamp is named with "on"/"off" and an off lamp is
  hollow; a gate's pips are a meter. A pressable part or row is a button with
  a name (its title, else its step) and a focus ring.
- **Preferences**: reduced motion snaps every transition and runs no loop, and
  still shows every step without moving: the part a token arrived in, or what
  the plugin asked to pulse, is outlined in `--bd-lit` for `MARK_MS`; a busy
  core's ring, a busy press's scanner and an active trace are drawn lit;
  reduced transparency makes the plates near-solid and drops the sheen; more
  contrast makes them solid with a defined ring.

## Settings pages

Every settings page is built from the blocks in
`web/src/components/SettingsKit.tsx` and `SettingRow`:

- `SettingsCard` — one group: an optional icon chip (`icon`, tinted with the
  page's group hue), a title, one sentence under it, and its rows. Its `status`
  (a `StatusBadge`) and its one action (`actions`: Recheck, Add) sit at the
  header's top right in every state, loading included. The line under the
  header is the first row's divider, so a card with no header has none. `fold`
  makes the header a disclosure. Groups inside a card become cards of their
  own; no eyebrow headings inside a card.
  - `tone="decision"` is a card that needs the person to decide something (the
    gate is off, a step is theirs): an amber edge along its top. Use it for the
    one card on a page to read first, not as decoration.
  - `tone="danger"` is the separate red-tinted "Danger zone" card. Whatever
    `Button` sits in it is an outline in the error colour, never filled, and
    what it does is reversible, said in the wording ("Disable hooks", not
    "Delete").
  - `wide` is for a card that is a list, an editor or a table: it spans every
    column of the page flow.
- `SettingRow` — the name 13.86px bold in `--text`, the help one muted line
  in 11.76px `--text3` under it, shown whole (never clamped, no More/Less). Long
  text goes in `detail` (named "Details"), a `Disclosure` under the help; on a
  row that is itself a button (a `Toggle`) it is drawn as the next sibling,
  `.agx-row-more`, so the row keeps one click target. A card is 13px radius with
  the mockup's soft lower shadow; its header is a 22px icon chip, the title
  15.96px bold, and the sentence under it 12.04px; the page title is 23.1px bold.
  The control column is
  `status` first, then `control` or `actions`, as wide as its content and no
  wider; the words keep 14rem, so a control wider than the rest (a three-way
  choice) wraps inside its own track. Inline in that column: one switch,
  segmented set, select, stepper, badge, or at most two buttons. Everything
  else — a text field, a form, a list, a preview — goes in `below`, which
  spans the row. In a card narrower than 440px the control drops under the
  words. The switch is green when on, the segmented choice raises the chosen
  one on the page's ground, and every select on a settings page is the page's
  ground with an edge, 32px tall. Text fields and native selects on a settings
  page take the page's ground, a visible edge (`--border2`) and the primary as a
  3px ring on focus. A short exclusive choice in a row (display size, 12h/24h) is
  `SegControl` from `SettingsKit`; a numbered list (what happens at login) sits
  in `.agx-steps`, 22px inset circles and no rule between steps.
- The look preferences (`lib/lookPrefs.ts`) are four attributes on `<html>` that
  `index.css` reads and nothing else does: `data-density` scales the 8/10/12px
  vertical padding steps and the Settings rows, `data-ui-font` scales every
  `text-[Npx]` class and every size the stylesheet sets (written
  `calc(Npx * var(--agx-fs, 1))`, so a new bare `font-size: Npx` is refused by
  `look-prefs.test.ts`), `data-translucent` lets `--surface-nav` through, and
  `data-reduce-motion` ends every animation. Density and font size are written
  without `html`, so a preview can wear its own value. The Appearance and
  Window previews are the app's own screens (a Settings page, the Lantern's
  cards, a diff) in a window laid out at the Display size, never the Dashboard.
- The nav group hues are five fixed mid-tones, the same in every theme
  (`--g-general` #6b7bb8, `--g-workspace` #3f9a93, `--g-agents` #d98a6c,
  `--g-library` #c4982f, `--g-connections` #5c8fc4): used only as a 17% tint, a
  3px bar on the chosen nav row and a glyph mixed with the text colour.
- `StatusBadge` — one chip family for a row, a card header and the page
  header: 22px (`CTRL_H.compact`), a dot and a few words, on a tint of the
  hue, in that hue's `--*-ink`: `ok`, `warn` (only when the person is needed),
  `err`, `info` (worth knowing, nothing to do), `off` (hollow: not connected,
  not installed), `checking`.
- `Disclosure` — a `<details>` whose summary names what it holds ("Where the
  token is stored"), never "More" or "About this one". Closed it is one quiet
  line with a caret; open, what it holds sits in an inset panel.
- `SettingsForm` and `Field` — stacked fields, label above, one line of help
  under, 480px at most, one primary submit at the end with the error under
  it. A segmented choice that changes which fields exist comes first. "How
  to get one ↗" is `Field`'s `link`, on the label's line.
- `LinkButton` — a link out drawn as a plain `Button`; `agx-textlink` is an
  action inside a sentence ("Change workspace").
- `EmptyState` — one sentence for a card with no rows yet; the action that
  fills it stays in the card header.

- Engine tile (`orchestration/EngineTile.tsx`) — a neutral letter at
  `CTRL_H.compact`, the engine's name, its model and its state as a dot and a
  word; the reason is the hover, or a line on the tile when it cannot be
  picked. "Right now" (`FlowView.tsx`) lays the main agent (200-240px) beside
  the jobs, whose name column is 150px; below 720px they stack and the wires
  go. A job a rule moved has a `--success` edge.
- Project bar (`orchestration/ScopeBar.tsx`) — the chips, one line and the one
  action, `sticky top-0 z-10` on `var(--bg)` with a `LINE` under it. It writes
  its height to `--orch-stick`, and a card or row on that page keeps
  `scroll-margin-top` of that plus 8px, so a jump lands under the bar.
- Safety and limits (`OrchestrationPane.tsx`) — one `SettingsCard` with `fold`,
  shut until opened, `defaults` in the status slot while nothing in it differs
  from a fresh install. Inside, each group is a 13px semibold name over one
  12px sentence (`SafetyHead`), then the rows; every row's hint is one
  sentence and an `Example:` in invented names.

The page flow: cards go down one column, two from 1180px, three from 2300px,
in document order, and a card never splits across columns (CSS columns on
`.agx-settings-col`, not a grid, so short cards pack under each other). A page
does not choose its column count; it orders its cards and marks the wide ones.
A board (`WIDE_PANES` in `SettingsModal.tsx`: a grid or a map of its own) is
one column at the width it names, set on the page so the "On this page" rail
still sits beside it. A page still on the old `Section` box spans every column
until it moves. The rows of a card answer to the card's width, not the
window's.

From 2200px the page is zoomed 1.107 (the mockup's 14 to 15.5px root), the nav
is not. Below 1100px the nav is a 68px icon rail: labels, counts and legend go,
and the one mark kept is a red dot (`data-keep`) on a page that failed, because
nothing else says so there. Two pages must not share a glyph for the same reason.

The three states a page has besides "fine" (`lib/settingsStates.ts`):

- **Saving**: `SaveChip` in the card header (`useSavePhase`: Saving, then Saved
  for 2.5s; a write that failed is never Saved) and a "Saving" chip beside the
  page header's verdict (`useReportSaving`). Never a silent write.
- **Could not read**: the page reports its own failed fetch with
  `useReportProblem(pageId, { chip, title }, retry)`; the shell turns the nav
  dot red and the header chip red and puts Try again in the header. In the page
  the failure is a `tone="error"` card holding a `ProblemNote` with its retry.
  A state a page cannot really be in gets no report.
- **Empty list**: `ListPanel blank={...}` (a list with nothing in it, not a
  filter that matched nothing): an icon, one sentence, and the action that
  fills it.

One divider: `.agx-scard-body > .agx-settings-row + .agx-settings-row`, edge to
edge, which is also what draws the line under a card's header. Spacing is
4 · 8 · 12 · 18 · 24; buttons 28px (`CTRL_H.regular`), inputs 32px (`INPUT`).
Below 1100px the settings nav is a 68px icon rail and the page gutter 18px, so
the 640px window still has a column.

Pages still on the old `Section` box are listed with their counts in
`web/test/settings-ratchet.txt`; a page that moves keeps its card titles (the
search index keys rows by them) and goes in the test's `MIGRATED` list.

## Guards

Every one reads source as text; there is no renderer to mount a view.

- `surface-ratchet.test.ts` with `ratchets.txt` — fails when the count of
  direct `var(--bg2)` fills (`bg2-fill`) or of borders off the house pair — any
  `edge(n)` but `edge(14)`, any `1px solid` spelled out (`border-literal`) — is
  above its ceiling in `ratchets.txt`, and also when it is below it, so the
  commit that lowers the count lowers the line.
- `radius-canon.test.ts` — fails on `rounded-2xl` or a bracketed
  `rounded-[Npx]` anywhere in `src/components`.
- `button-wrapper.test.ts` — fails when a button wrapper (the PR panel's `Btn`,
  the git card's, Docker's, the browser column's) draws its own `<button>`
  instead of `Button`, when `Button` stops taking its height from `CTRL_H` or
  its corners from `rounded-lg`, or when a PR Files toolbar button is not
  compact.
- `input-token.test.ts` — fails when a non-checkbox `<input>` in
  `src/components` does not use `INPUT` and is not on the test's allowlist, or
  when an allowlist entry no longer matches a real input.
- `view-audit-controls.test.ts` — fails when the pull request's section strip
  or the Machine dialog's sections are not the shared `Tabs` over a tabpanel,
  when Escape does not close the Machine dialog, or when the triage card's
  button is off `CTRL_H.compact` or `rounded-lg`.
- `view-chrome.test.ts` — fails when a view's header chip is not the one
  `CHIP` shape, is under 28px (a tab under 32px), loses its hover rule, is
  copied into a view instead of imported, or when `Segmented` draws a box.
- `toolbar-control-height.test.ts` — fails when `CTRL_H.regular` is no longer
  the refresh button's height, or a named header control goes back to a bare
  `py-1`/`py-0.5`.
- `contrast-ink.test.ts` — fails when any shipped theme's `--*-ink` is under
  4.5:1 on its ground, or `inkFor` stops preferring the tint, then its ANSI
  twin, then a mix.
- `contrast-floor.test.ts` — fails when a shipped theme's `--text2`/`--text3`/
  `--text4`, once floored, misses `TIER_TARGET` or the tiers invert.
- `icon-scale.test.ts` — fails when the `ICON` ladder stops ascending or drops
  under 12, when `HIT` is not larger than the glyph, or when an inline `<svg>`,
  a call site or an icon's default asks for less than `ICON.xs`.
- `no-glyph-icons.test.ts` — fails when an icon is typed as a character (a
  `×` close) instead of drawn.
- `spacing-scale.test.ts` — fails on arbitrary pixel spacing off the 2px grid
  outside the allowed indents, and when the scale leaves `tailwind.config.js`.
- `layers.test.ts` — fails when two `LAYER` entries swap the order the app
  depends on.
- `canvas-source-guard.test.ts` — fails when a live canvas's files (the board
  and its stylesheet among them) contain markup injection, a DOM lookup, an
  image, a link, a frame, a style built as a string, Markdown, code from a
  string or a fetch, when its motion file or the board's stylesheet animates
  anything but `transform` and `opacity`, or when a tone table is indexed by
  anything that did not go through `toneOf`.
- `layer-owner.test.ts` — fails when a shared menu, picker or dialog stops
  closing when the bench it was opened from is hidden.
- `settings-page-rules.test.ts` with `settings-ratchet.txt` — reads every
  settings page's own source (its block in `SettingsModal` and the components
  it renders, three levels down) and fails when a migrated page has any of
  the defect classes (the old box, an eyebrow heading, clipped prose, a vague
  More, a text field in the control column, a hand-rolled `py-1` button, a
  bare tint as text), when another page's count rises above or falls below
  its ceiling, when a kit selector draws a border other than the one
  divider, or when a disclosure's summary is vague.
- `design-system-doc.test.ts` — fails when a name in the table above is not
  defined in the file it names, or a number there is not its value.

## Adding a view

1. Build it from the components and tokens above. A new number, colour, radius
   or border updates this page in the same commit.
2. Render it and look at it in a light theme and a dark one. A tint that reads
   on one can vanish on the other.
3. Run the guards before committing — `make check` runs them all — and keep
   them green. A ratchet's ceiling only moves down.
4. A menu, picker or dialog that floats calls `useCloseWithOwner` (a question
   put to the person, `useOwnedQuestion`), so it closes with the bench it was
   opened from. A dialog answers "no" then, never "yes".
