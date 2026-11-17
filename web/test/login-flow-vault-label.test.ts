import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/settings/pages/LoginFlow.tsx", import.meta.url)).text();

describe("Settings > Browser: a vault source's label", () => {
  test("a long profile name truncates with its full name on hover, never over the wire", () => {
    const row = src.slice(src.indexOf("data-flow-box={b.source}"), src.indexOf("data-flow-box={b.source}") + 900);
    /* The tip's own descendant is the one measured (TipHost labelShown). */
    expect(row).toMatch(/data-tip-unless-shown="\.truncate"><span className="block truncate">/);
    expect(row).toContain('data-tip-unless-shown=".truncate"');
    expect(row).not.toContain('<b className="whitespace-nowrap"');
  });
});
