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
- `design-system-doc.test.ts` — fails when a name in the table above is not
  defined in the file it names, or a number there is not its value.

## Adding a view

1. Build it from the components and tokens above. A new number, colour, radius
   or border updates this page in the same commit.
2. Render it and look at it in a light theme and a dark one. A tint that reads
   on one can vanish on the other.
3. Run the guards before committing — `make check` runs them all — and keep
   them green. A ratchet's ceiling only moves down.
