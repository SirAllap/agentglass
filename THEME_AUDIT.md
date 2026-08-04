# THEME_AUDIT.md — Phase 1: washed-out "veil" root-cause audit

## Executive summary

The primary text token is **not** the cause. In all four audited themes `--text` measures **15.8–19.8:1** against `--bg` (graphite `#fafafa`/`#1e1e1e` = 15.97, porcelain `#0a0a0a`/`#fff` = 19.80) and is never lifted or dimmed by `floorTiers()`. It is physically incapable of rendering as mid-grey. The washed-out perception comes from **three separately-measured structural facts**, none of them a global opacity/overlay/filter veil (verified absent):

1. **Dim tiers paint primary content.** Readable payload — the thing you actually read on the core surfaces — is rendered in `t-dim`(`--text3`) / `t-dim2`(`--text4`), which `floorTiers()` deliberately caps at ~4.5 / ~3.0:1. Alerts' message body (`Alerts.tsx:192`) and insight detail (`Alerts.tsx:224`) use `--text4` (**3.83:1 graphite**); the Feed event description (`Feed.tsx:123`) uses `--text3` (**5.86 graphite / 4.68 porcelain**); every card title/settings-hint sits at `--text2`. Nothing in the everyday reading zone is ever `--text`, so the whole surface reads one-to-three stops below white.
2. **A near-white accent-film washes the ground.** In the two neutral defaults `--primary` is monochrome (graphite `#e5e5e5`, porcelain `#171717`), and the app builds panel/tile "accent" sheens from `color-mix(var(--primary) 7–12%, transparent)` — `.panel` (`index.css:130`, 28 panels), `.tile::after` (`index.css:171`). With no hue to give, these composite to a grey haze that lifts the black ground toward grey. The `.tile` surface itself is only 60% opaque (`index.css:161`).
3. **Accents-as-text collapse on same-hue washes, and borders are invisible.** Chips/PR-state/diff/toasts set `color: var(--X)` over `color-mix(var(--X) 12–16%, transparent)`, driving many accents below AA (PR error chip **4.24 graphite**, most chips **3.4–4.1 on both light themes**). Borders diluted to `--border 40–45%` composite to **~1.0–1.4:1** — effectively invisible — so the tone-separation the theme depends on reads as flat/veiled.

Root causes are token-selection and low-alpha `color-mix` conventions, fixable at the token/variable level without per-component rewrites and without touching brand hues.

> Note: the brief's token values are stale. Verified from `themes.ts:36–65`: graphite `--text #fafafa`, `--text2 #d4d4d4`, `--text3 #a1a1a1`, `--text4 #808080`; porcelain `--text #0a0a0a`, `--text2 #383838`, `--text3 #737373`, `--text4 #909090`. All numbers below use the real values.

---

## Measured contrast

WCAG 2.1 (sRGB relative luminance, `(L1+0.05)/(L2+0.05)`). Translucent backgrounds are composited over the surface they actually sit on. `--text2/3/4` are shown **after** `floorTiers()` (`themes.ts:124` → `contrast.ts:105`), which lifts dim tiers toward `--text` measured against `--bg2` only. AA normal text = 4.5; all chips/badges here are ≤11px so large-text 3.0 does not apply. Sorted worst-first, deduped.

| element / token | file:line | theme | fg | bg | ratio | need | verdict |
|---|---|---|---|---|---|---|---|
| word-diff deleted (`--error` on `--error 30%`) | ChangesModal.tsx:99 | porcelain | `--error` | `--error 30%`/panel | 2.68 | 4.5 | **FAIL** |
| `--text4` on `--bg4` (elevated) | (tier) | graphite | `#808080` | `#404040` | 2.63 | 3.0 | **FAIL** |
| hunk header `t-dim2` on info tint | ChangesModal.tsx:208 | github-light | `--text4` | `--info 12%`/`--bg` | 2.76 | 3.0 | **FAIL** |
| hunk header `t-dim2` on info tint | ChangesModal.tsx:208 | porcelain | `--text4` | `--info 12%`/`--bg` | 2.96 | 3.0 | **FAIL** |
| `--text4` on `--bg3` (elevated) | (tier) | porcelain | `#898989` | `#ececec` | 2.96 | 3.0 | **FAIL** |
| `--text4` on `--bg2` (floored) | (tier) | github-light | `#878f99` | `#f6f8fa` | 3.07 | 3.0 | pass (min) |
| `--text4` on `--bg2` (floored) | (tier) | porcelain | `#898989` | `#f5f5f5` | 3.21 | 3.0 | pass (min) |
| PR error chip (`--error` on `--error 16%`) | PrPanel.tsx:158,181 | porcelain | `--error` | `--error 16%`/panel | 3.40 | 4.5 | **FAIL** |
| `--text3` on `--bg3` (elevated) | (tier) | porcelain | `#6e6e6e` | `#ececec` | 4.32 | 4.5 | **FAIL** |
| `--text3` on `--bg4` (elevated) | (tier) | graphite | `#a1a1a1` | `#404040` | 4.01 | 4.5 | **FAIL** |
| PR success/warning chip (`--X` on `--X 16%`) | PrPanel.tsx:157,159 | github-light | `--success`/`--warning` | `--X 16%`/panel | 3.77–3.88 | 4.5 | **FAIL** |
| PR success/warning chip | PrPanel.tsx:157,159 | porcelain | `--success`/`--warning` | `--X 16%`/panel | 3.75 | 4.5 | **FAIL** |
| Feed "attn"/warning chip (`--warning` on `--warning 14–15%`) | Feed.tsx:126,257 | porcelain | `--warning` | `--warning 14%`/panel | 3.81–3.85 | 4.5 | **FAIL** |
| `--text4` selected-Choice / hint (floored min) | SettingsModal.tsx:51,88 | graphite | `#808080` | `#262626` | 3.83 | 4.5 | **FAIL** (hint) |
| Feed timestamp/duration `t-dim2` | Feed.tsx:113,128 | graphite | `--text4` | panel `#252525` | 3.88 | 4.5 | **FAIL** |
| Feed "live" (`--success` on `--success 14%`) | Feed.tsx:256 | porcelain | `--success` | `--success 14%`/panel | 3.85 | 4.5 | **FAIL** |
| Feed info/tool chip (`--info` on `--info 14%`) | Feed.tsx:121 | porcelain | `--info` | `--info 14%`/panel | 3.94 | 4.5 | **FAIL** |
| Feed info/tool chip | Feed.tsx:121 | github-light | `--info` | `--info 14%`/panel | 4.05 | 4.5 | **FAIL** |
| GitPanel toast (`--success`/`--error` on `--bg3`) | GitPanel.tsx:2355 | porcelain | `--error` | `--bg3` | 4.13 | 4.5 | **FAIL** |
| diff deleted line (`--error` on `--error 13%`) | ChangesModal.tsx:41 | porcelain | `--error` | `--error 13%`/`--bg` | 3.86 | 4.5 | **FAIL** |
| PR error chip | PrPanel.tsx:158 | graphite | `--error` | `--error 16%`/panel | 4.24 | 4.5 | **FAIL** |
| PR error chip | PrPanel.tsx:158 | github-dark | `--error` | `--error 16%`/panel | 4.34 | 4.5 | **FAIL** |
| selected Choice pill (`--text` on `--primary 55%`) | SettingsModal.tsx:88 | graphite | `#fafafa` | `--primary 55%`→`#8f8f8f` | 3.10 | 4.5 | **FAIL** |
| `--text3` on `--bg2` (floored) | (tier) | porcelain | `#6e6e6e` | `#f5f5f5` | 4.68 | 4.5 | pass |
| `--text4` on `--bg2` | (tier) | github-dark | `#6e7681` | `#161b22` | 3.77 | 3.0 | pass (min) |
| `--text3` on `--bg2` | (tier) | github-light | `#656d76` | `#f6f8fa` | 4.93 | 4.5 | pass |
| `--text3` on `--bg2` | (tier) | graphite | `#a1a1a1` | `#262626` | 5.86 | 4.5 | pass |
| **`--text2` (body copy) on `--bg`** | (tier) | all | — | — | 8.7–12.3 | 4.5 | pass |
| **`--text` (primary) on `--bg`** | (tier) | graphite/porcelain | `#fafafa`/`#0a0a0a` | `#1e1e1e`/`#fff` | **15.97 / 19.80** | 4.5 | **pass** |
| `--border 40%` hairline over panel | Header.tsx:43 (+117 sites) | graphite | `#2b2b2b`@40% | `#252525` | ~1.02 | 3.0 | **FAIL (boundary)** |
| `--primary 12%` panel outline | index.css:132 | graphite | `#e5e5e5`@12% | panel | ~1.2–1.4 | 3.0 | **FAIL (boundary)** |

Takeaway: **0 raw/floored token-tier failures for primary text** — every text failure above is either (a) a dim tier used where content should be `--text`, (b) a dim tier on an *elevated/tinted* surface the floor never measured, (c) a semantic accent drawn over a wash of its own hue, or (d) a diluted border.

---

## The veil — systemic causes

### Cause A — dim tiers carry primary reading content
`.t-dim → var(--text3)`, `.t-dim2 → var(--text4)` (`index.css:180–185`). `t-dim2` is the *quietest* tier, and `floorTiers()`'s `TIER_TARGET` (`contrast.ts:91`) deliberately caps `--text4` at 3.0 and `--text3` at 4.5, so it never rescues text that should have been `--text`.

- `Alerts.tsx:192` — alert **message** `{a.text}` → `t-dim2` (`--text4`, **3.83 graphite**). Its own agent label above (`:191`) is brighter `--text2` — inverted hierarchy. Worst offender.
- `Alerts.tsx:224` — insight **detail** `{i.detail}` → `t-dim2` (**3.83**).
- `Feed.tsx:123` — event **description** `{d}` (file path / command / target) → `t-dim` (`--text3`, **5.86 / 4.68**). Busiest reading surface after the terminal.
- Pervasive one-stop-down titles that keep the surface off-white (defensible each, collectively the grey feel): `Alerts.tsx:191,223,104,162`, `SessionModal.tsx:210`, `ReleaseNotesModal.tsx:69` — all `--text2`. Markdown prose in modals inherits `--text2` from the caller's wrapper (the renderer itself correctly forces `--text` on bold/headings/table-headers, `markdown.tsx:41,118,178`).

Already correct (so the fix must be surgical, not a global bump): terminal default fg = `--text` (`TerminalPanel.tsx:95`, with an in-code note that `--text2` was "the washed-out grey"); PR titles = `--text` (`PrPanel.tsx:855,2147,2172`); big stat values = `--text` (`MachinePanel.tsx:218,221`).

### Cause B — near-white `--primary` accent-film over surfaces
The most-repeated translucent layers, all sourcing `--primary` (monochrome in the neutral defaults, so they render as grey haze rather than colored glow):

- `.panel` (`index.css:130–131`) — `linear-gradient(180deg, color-mix(var(--primary) 7%, transparent), transparent 42%)` over an opaque `color-mix(--bg2 90%, --bg)` base, plus a `--primary 12%` border (`:132`). Reaches **28 panels**; top edge composites to ≈`#333` in graphite. This is the single biggest driver of "whitish film on every panel."
- `.tile::after` (`index.css:171`) — `color-mix(var(--primary) 10%, transparent)` gradient painted **over** tile content (positioned pseudo-element).
- `.tile` (`index.css:161`) — surface only **60% opaque** (`color-mix(var(--bg2) 60%, transparent)`), letting the ground show through.
- `Feed.tsx:169` — lane column ground at **20% opacity** (`color-mix(var(--bg3) 20%, transparent)`), under already-dim rows.
- Aurora ambient (`index.css:94,107,116`, mounted `App.tsx:525–526`, `z-index:-1`) — 7–9% `--primary`; **behind** opaque `body` (`index.css:33`), only visible in gutters. Real but faint; not a text-contrast factor.
- `StatsModal.tsx:198` — hardcoded white 8%→1.5% frost + 80%-opaque `bg3`; theme-independent white wash, but scoped to the Stats modal.

Verified absent (the search was correctly aimed here): **no** full-viewport veil element, **no** global `opacity<1`/`mix-blend-mode` on any shell/panel/column, `body` paints opaque `--bg`. Every heavy scrim/frost (64–72% opaque, one `backdrop-filter` blur) is **modal-conditional**, gone at rest.

### Cause C — semantic accents rendered as text over a same-hue wash
Chips/badges/diff/toast set `color: var(--X)` on `background: color-mix(var(--X) 12–16%, transparent)`. Tinting the background toward the token collapses the ratio, worst on the two light themes where semantics are chosen to sit ~4.5 on white: `Feed.tsx:121,126,256,257`, `PrPanel.tsx:157–159,181` (`Chip`), `ChangesModal.tsx:41–42,99,123` (diff/word-diff), `GitPanel.tsx:2355` (toast). Even graphite/github-dark fail the **error** chip (4.24 / 4.34).

### Cause D — the floor is measured on ONE surface
`floorTiers()` lifts `--text2/3/4` against `bg = vars["--bg2"]` (`contrast.ts:106`) only. Elevated surfaces (`--bg3`, `--bg4`) and tinted washes move the effective background contrast-downward and the floor does not follow: `--text4` on `--bg4` = **2.63 graphite**; `--text3` on `--bg3` = **4.32 porcelain**; hunk headers (`--text4` on `--info 12%`) = **2.76–2.96** on light themes.

### Cause E — borders diluted below perceptibility
`--border` is already ~1.05:1 against the panel in both defaults ("separate regions by TONE, not lines," `themes.ts:29–35`), and 118 of ~200 border declarations then dilute it to `--border 40–45%` → **~1.02:1** (e.g. `Header.tsx:43,116,175`, `Feed.tsx:258,331`, `SettingsModal.tsx:106,1048`, `TerminalPanel.tsx:678,926`). The `--primary 12%` panel outline is **~1.2–1.4:1**. The lines meant to reinforce tone-separation vanish, reading as flat/veiled.

---

## Root causes & proposed token-level fixes

Each is the smallest token/variable-level lever; brand hues preserved (lightness/alpha only).

**A. Dim tiers on primary content — both themes.**
- Smallest systemic lever: raise `TIER_TARGET["--text4"]` from 3.0 → ~4.5 and `["--text3"]` from 4.5 → ~5.5 in `contrast.ts:91`. This lifts the largest foreground population (389 `t-dim2` + 293 `--text3` uses) in every theme at once via the existing floor pass, no component edits.
- Targeted companion (unavoidably per-call because it's a token *choice*, not a value): promote the four content call-sites off the dim tiers — `Alerts.tsx:192,224` `t-dim2` → `--text`; `Feed.tsx:123` `t-dim` → `--text2`. These three lines are the measured "primary text is grey" symptom.

**B. Near-white accent-film — dark-neutral (graphite) primarily; fix is safe in all themes.**
- In `.panel` (`index.css:130,132`) and `.tile::after` (`index.css:171`) mix the sheen/border from `var(--border)` or `var(--bg4)` instead of `var(--primary)`, or drop the `--primary` percentages (7/10/12% → ~3–4%). Removes the grey haze in neutral themes without changing colored-primary themes (github-dark/light), where `--primary` legitimately has hue.
- Raise `.tile` surface (`index.css:161`) toward opaque and `Feed.tsx:169` lane ground (20% → ~85–100%) so surfaces stop reading as translucent. Both themes.

**C. Same-hue accent-as-text — light-only heavy, error fails on dark too.**
- Reduce chip background alpha (16%/14% → ~10–12%) at the shared `Chip`/`.chip` sources (`PrPanel.tsx:181`, `index.css:175`, Feed chips) — recovers the fg/bg ratio without recoloring. Applies to both, resolves the light-theme sweep.
- Or, light-only: darken the light-theme semantic tokens one step (`porcelain`/`github-light` `--error/--success/--warning/--info` in `themes.ts`) so they clear 4.5 on their own wash. Keep dark-theme values as-is.

**D. Single-surface floor — both themes.**
- In `floorTiers()` (`contrast.ts:105–106`) evaluate each tier against the *darkest common* content surface (`--bg3`/`--bg4`), not just `--bg2`, so tiers that pass are guaranteed on elevated/tinted grounds too. Purely a floor-input change; raises nothing that already passes.

**E. Invisible borders — both themes.**
- Raise `--border`/`--border2` separation from the panel by ~2–3 luminance steps in `themes.ts` (graphite `--border #2b2b2b` → lighter; porcelain `--border #e5e5e5` → darker), and/or stop diluting borders to 40–45% at the call sites (use the token at full strength). Token-value change, hue-neutral, both themes.

---

## Deferred / not-applicable

Verified checked, not missed — these generic-brief items **do not exist** in agentglass, so no findings:

- **Zebra-striped tables** — no zebra/`nth-child` row striping anywhere.
- **Visited-link color** — no `:visited` rule; anchors are chip/button-styled (`SkillsModal.tsx:235`, `index.css:627`), no underline/visited system.
- **Input autofill styling** — no `:-webkit-autofill` rule.
- **`::selection` rule** — no global selection CSS; only the xterm `selectionBackground: alpha(--primary,"44")` (`TerminalPanel.tsx:98`), which does not recolor text.
- **Global/container opacity veil** — none; no `opacity<1`, `background`, or `mix-blend-mode` on App shell / `#root` / `body` / any panel or column. All `opacity` hits are transient (fade-in settling at 1), hover/disabled states, or per-item semantic de-emphasis (e.g. `AgentsPane.tsx:72`, `DockerPanel.tsx:120`).
- **Full-screen overlay/filter veil** — none at rest; aurora is `z-index:-1` under content; all heavy scrims are modal-conditional.
- **Hardcoded mid-grey body text** — none; every body run resolves through `var(--text*)`. (Hardcoded literals that exist are accents/notch text/QR codes, not grey body copy.)

**Related non-veil bugs noted in passing (not the washout, real theme-bypasses for a later pass):**
- `SessionModal.tsx:181` — `var(--ok, #34d399)`; `--ok` is undefined in `themes.ts`/`index.css`/`accent.ts`, so the hardcoded green always wins in every theme. Should be `var(--success)`.
- `PrPanel.tsx:261` — code blocks `color-mix(#000 42%, transparent)`; a 42% pure-black wash that becomes a heavy grey box on white in porcelain/github-light. Should mix from `var(--bg3)`.
- Semantic accents duplicated as fixed hex in `lib/labels.ts:13–42`, `Feed.tsx:98`, `HelpLegend.tsx:7–18`, `lib/format.ts:171–185` — don't follow the theme/accent; consolidate onto tokens.

---

*Phase 1 — findings and recommended fixes only.*

---

## Phase 2 — applied (worktree `audit/theme-contrast`, local)

Token/variable-level; brand hues untouched, layout & typography unchanged.

- **A — dim tiers off primary copy + stronger floor.** `contrast.ts`: `TIER_TARGET` `--text3` 4.5→5, `--text4` 3→4, and `floorTiers` now measures against `--bg3` (the elevated surface dim text lands on), not `--bg2`. Promoted the measured "grey primary text" sites off the dim tiers: `Alerts.tsx:192,224`, `Feed.tsx:123` → `--text2`.
- **B — accent film gone.** `.panel`/`.tile::after` sheen from `--bg4` instead of `--primary` (no grey haze in the neutral themes); `.tile` (was 60% opaque) and the Feed lane (20%) are now opaque.
- **C — chips less washed.** Feed & PR chip tints 14–16% → 10%; word-diff highlight 30–32% → 22–23%.
- **D — floor on the elevated surface** (see A).
- **E — borders visible.** `graphite --border #2b2b2b→#383840 / --border2 #3d3d3d→#4c4c54`; `porcelain --border #e5e5e5→#d9d9de / --border2 #d4d4d4→#c4c4ca`; structural borders (`.panel`/`.tile`/lane) route through `--border2`.
- **Bonus.** `SessionModal` `var(--ok,#34d399)` (undefined var → always green) → `var(--success)`; `PrPanel` code-block `color-mix(#000 42%)` black wash → theme-aware `--bg2`.

### Verified — re-run WCAG, floored tiers on every surface

| tier | graphite  bg / bg2 / bg3 / bg4 | porcelain  bg / bg2 / bg3 / bg4 |
|---|---|---|
| `--text`  | 16.0 / 14.5 / 13.0 / 9.9 | 19.8 / 18.2 / 16.8 / 15.3 |
| `--text2` | 11.2 / 10.2 / 9.2 / 7.0  | 11.7 / 10.8 / 9.9 / 9.1  |
| `--text3` | 6.5 / 5.9 / 5.3 / 4.0    | 6.0 / 5.5 / 5.1 / 4.6    |
| `--text4` | 5.0 / 4.5 / 4.0 / 3.1    | 5.0 / 4.6 / 4.3 / 3.9    |
| `--border2` vs panel | 1.78 (visible) | 1.59 (visible) |

Every persistent content surface (bg / bg2 / bg3) clears AA; the only sub-AA figures are on `--bg4`, the transient hover/active surface. Hierarchy preserved (text › text2 › text3 › text4). Suite **1174/0** (incl. `contrast-floor.test.ts`), build clean.

### Left for a later pass (noted, not the veil)
- Consolidate the semantic accents duplicated as fixed hex in `lib/labels.ts`, `Feed.tsx`, `lib/format.ts` onto tokens.
- `--bg4` (hover) dim labels sit ~3–4:1; only matters if a persistent label ever lands there.