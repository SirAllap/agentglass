/*
 * A page whose content fits the window does not scroll. The index rail used to
 * span twenty grid rows to stay beside a tall page; every implicit row carried
 * the page's gap, so a short page (Window & startup) could be scrolled about
 * 340px into empty space.
 */
import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url).pathname).text();

test("nothing is left under the last card: no gap kept by the column, a short bottom pad", () => {
  expect(css).not.toContain("data-stable");
  expect(css).toMatch(/\.agx-settings-page \{ --agx-settings-pad-top: 22px; --agx-page-gap: 18px; padding: var\(--agx-settings-pad-top\) 40px 28px;/);
});

test("the 'Drawn, not a capture' chip is neutral: amber means the person is needed", async () => {
  const frame = await Bun.file(new URL("../src/components/settings/previews/Frame.tsx", import.meta.url).pathname).text();
  expect(frame).toContain('<StatusBadge tone="off">Drawn, not a capture</StatusBadge>');
});
