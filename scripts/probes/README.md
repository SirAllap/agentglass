# Probes

Expressions for `scripts/eyes.ts --do-file`. Each one drives the running app and
returns a JSON string, so a claim about the interface can be a number instead of
a memory.

    bun scripts/eyes.ts --do-file scripts/probes/<name>.js

They live in the repo rather than in somebody's scratchpad because that is where
the last run went looking for them and could not find them: the 98.4%-of-one-tone
figure that started the contrast work was un-reproducible by the next person to
need it, so it went un-checked.

| file | answers |
|------|---------|
| `tone-histogram.js`  | what share of the painted area is a single colour, and how many tones there are at all |
| `views-sweep.js`     | the same, per view in the rail, plus how many icon-only controls are under the floor |
| `settings-audit.js`  | every settings page: how many groups, how many carry a heading, how many rows sit outside one |
| `icon-floor.js`      | every glyph under 14px, grouped, with its control's hit area |

Two flags matter here:

- `--serve <url>` points at a server that is ALREADY running instead of spawning
  an isolated one. The isolated server is the right default — it can never touch
  the operator's data — but it also means every screen is measured against an
  empty database. "Twenty-three identical rows collapse to one" is not a claim
  an empty log can support.
- `--do-file` rather than `--do`: a walk over twenty-five pages does not survive
  being a shell argument. A backslash in a regex is eaten once by the shell and
  again by the template literal it is spliced into, and the expression then fails
  to parse with nothing to show for it but `--do: undefined`.
