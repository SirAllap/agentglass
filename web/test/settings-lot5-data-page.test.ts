import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("Log digest lives on Data & privacy, not About", () => {
  expect(rd("../src/components/settings/pages/DataPage.tsx")).toContain("<LogDigestSection");
  expect(rd("../src/components/settings/pages/AboutPage.tsx")).not.toContain("LogDigestSection");
});

test("the privacy page renders through the data module", () => {
  expect(rd("../src/components/SettingsModal.tsx")).toContain('show("privacy") && <DataSettingsPage c={pageCtx} />');
});
