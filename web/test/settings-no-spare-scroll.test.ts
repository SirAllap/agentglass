/*
 * A page whose content fits the window does not scroll. The index rail used to
 * span twenty grid rows to stay beside a tall page; every implicit row carried
 * the page's gap, so a short page (Window & startup) could be scrolled about
 * 340px into empty space.
 */
import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url).pathname).text();

test("the index rail shares the content's row instead of spanning spare rows", () => {
  expect(css).not.toMatch(/\.agx-settings-page > \.agx-toc \{[^}]*grid-row:\s*1\s*\/\s*span/);
  expect(css).toMatch(/\.agx-settings-page > \.agx-toc \{[^}]*grid-row:\s*1;/);
});

test("nothing is left under the last card: no gap kept by the column, a short bottom pad", () => {
  expect(css).toMatch(/\.agx-settings-col\[data-stable\] > \.agx-scard \{ margin-bottom: 0; \}/);
  expect(css).toMatch(/\.agx-settings-col\[data-stable\] \{ margin-bottom: calc\(-1 \* var\(--agx-gap\)\); \}/);
  expect(css).toMatch(/\.agx-settings-page \{ padding: 22px 40px 28px;/);
});

test("the 'Drawn, not a capture' chip is neutral: amber means the person is needed", async () => {
  const frame = await Bun.file(new URL("../src/components/settings/previews/Frame.tsx", import.meta.url).pathname).text();
  expect(frame).toContain('<StatusBadge tone="off">Drawn, not a capture</StatusBadge>');
  const toc = await Bun.file(new URL("../src/components/SettingsToc.tsx", import.meta.url).pathname).text();
  expect(toc).toContain('".agx-scard-head .agx-badge"');
});
