# Third-party notices

agentglass itself is MIT-licensed — see `LICENSE`. This file records the
bundled third-party material that carries its own notice.

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
