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

## Agents screen icons — from Phosphor

The Agents screen draws with the [Phosphor](https://github.com/phosphor-icons/core)
icons (MIT licence, Copyright (c) 2020 Phosphor Icons), regular weight. The path
data of the forty-odd shapes it uses is in `web/src/components/agents/phosphor.tsx`,
unchanged apart from being held as strings.

> MIT License. Copyright (c) 2020 Phosphor Icons. Permission is hereby granted,
> free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software,
> and to permit persons to whom the Software is furnished to do so, subject to
> the following conditions: The above copyright notice and this permission
> notice shall be included in all copies or substantial portions of the
> Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
> EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
> EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
> ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.
