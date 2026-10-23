# Third-party notices

agentglass itself is MIT-licensed — see `LICENSE`. A small amount of bundled
artwork is not, and this file is where that is recorded. It exists because the
licence below asks for attribution, and a licence obligation that lives only in
a commit message is one nobody can discharge.

## Portrait artwork — the Understudy

The pixel-art portrait layers under
`web/src/components/understudy/persona/layers/` are the work of **Viktor Hahn**,
taken from [V-ktor/pixel-art-portraits](https://github.com/V-ktor/pixel-art-portraits).

> This work, made by Viktor Hahn (viktor.hahn@web.de),
> is licensed under the Creative Commons Attribution 4.0 International License.
> http://creativecommons.org/licenses/by/4.0/

That is the full text of `images/license.txt` as it ships in the upstream
repository, reproduced verbatim. A copy travels with the art itself at
`web/src/components/understudy/persona/ART-LICENSE.txt`.

**What CC BY 4.0 asks of us, and where each part is discharged:**

- *Credit the author.* Named here, and — because the art is compiled into the
  application binary where a file at the root of a source repository is invisible
  to anyone actually using it — also in the app, at **Settings → About**.
- *Link the licence.* The URL above, and the same URL beside the in-app credit.
- *Say whether changes were made.* **Yes.** The layers are recoloured at runtime:
  each PNG is treated as a channel mask (red weights the dark tone, green the
  light tone, blue the shadow tone) and tinted with colours the user picks, which
  is the technique the original Godot project uses. No pixel of the source art has
  been redrawn or redistributed in modified form; the tinting happens in the
  browser, at paint time.

CC BY 4.0 is not a copyleft licence. Nothing in it obliges agentglass to change
its own MIT terms, and nothing here restricts what you may do with the rest of
this repository.

## File-manager icons — from Strata

The Machine finder draws its chrome and its file types with the icons that ship
in [Strata](https://github.com/lgse/strata) (MIT), the file manager it follows.
They are copied unchanged into `web/src/assets/strata/`, and the tables that
choose one by file name (`map.json`) are generated from Strata's own source.

- `actions/` — Lucide icons (ISC licence, Copyright (c) 2026 Lucide Icons and Contributors). Text in `licenses/Lucide-ISC.txt`.
- `ctp/` — Catppuccin VSCode icons (MIT licence, Copyright (c) 2023 Catppuccin, thang-nm). Text in `licenses/Catppuccin-VSCode-Icons-MIT.txt`.
- Strata itself is MIT; its licence is in `licenses/Strata-MIT.txt`.

Changes made: the Lucide strokes carry Strata's default accent colour in the
files, and the finder replaces it with the colour of the surrounding text at
draw time; the Catppuccin files name their colours as `var(--vscode-ctp-*)`,
which the finder replaces with the Mocha or Latte value Strata uses.

## Deliberately not used

The **Universal LPC Spritesheet** collection was evaluated and rejected on
licence grounds rather than on quality. Its art is a mixture of CC-BY-SA 3.0 and
GPL 3.0 contributed by many authors; a portrait composited from it would be an
Adaptation and would have to be released under those terms, dragging the whole
application into copyleft and putting a "may not apply technological measures"
clause over a packaged Electron binary. That is a licence decision about the
entire product, and it is not one worth making to gain a few extra pairs of
spectacles.
