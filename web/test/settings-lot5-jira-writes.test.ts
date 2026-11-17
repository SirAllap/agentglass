import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/components/jira/JiraSettingsView.tsx", import.meta.url), "utf8");
const row = readFileSync(new URL("../src/components/SettingRow.tsx", import.meta.url), "utf8");

test("write-kind switches are disabled with a reason chip while changes are off, and keep their keys", () => {
  // Lot 7: the master switch and the four kinds live on Permissions > Changes outside, with the same keys and routes.
  const perm = readFileSync(new URL("../src/components/settings/pages/PermissionsPage.tsx", import.meta.url), "utf8");
  expect(perm).toContain('kind="locked');
  expect(perm).toContain("Turn on Changes in Jira first");
  expect(perm).toContain("settingId={`jira.writes.${w.kind}`}");
  expect(perm).toContain("api.jiraWriteKind(kind, v)");
  expect(view).not.toContain("jira.writes.");
});

test("a disabled row says so to assistive tech", () => {
  expect(row).toContain("aria-disabled={disabled || undefined}");
});
