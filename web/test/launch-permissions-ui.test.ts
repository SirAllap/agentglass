/**
 * The launch-permission UI, asserted against source (there is no renderer here).
 *
 * The two rows on the Terminal page are an escalation for every agent started
 * after them, so the agent door must never reach them; and the one-off "Run
 * with…" in the Review menu must reach the socket, or the menu offers a mode
 * that the terminal never hears about.
 */
import { describe, expect, test } from "bun:test";
import { requestTermReview, termReview, clearTermReview } from "../src/lib/termReview.ts";

const modal = await Bun.file(import.meta.dir + "/../src/components/SettingsModal.tsx").text();
const pr = await Bun.file(import.meta.dir + "/../src/components/PrPanel.tsx").text();
const term = await Bun.file(import.meta.dir + "/../src/components/TerminalPanel.tsx").text();

/** The JSX element that carries `label="…"`, from its `<SettingRow` to the label. */
function rowBefore(text: string, label: string): string {
  const at = text.indexOf(`label="${label}"`);
  expect(at).toBeGreaterThan(0);
  return text.slice(text.lastIndexOf("<SettingRow", at), at);
}

describe("launch permissions in Settings", () => {
  test("both rows are out of an agent's reach", () => {
    expect(rowBefore(modal, "Permission mode")).toContain("agentNever=");
    expect(rowBefore(modal, "Always deny")).toContain("agentNever=");
  });
});

describe("Run with… in the Review menu", () => {
  test("every mode is offered and runs in the terminal with it", () => {
    const at = pr.indexOf("function ReviewItem(");
    expect(at).toBeGreaterThan(0);
    const body = pr.slice(at, pr.indexOf("\n}\n", at));
    expect(body).toContain("LAUNCH_MODES.map");
    expect(body).toContain('run("term", m)');
  });

  test("the mode travels with the request to the socket", () => {
    requestTermReview("/repo/orbit", 1042, "apply", "", "bypassPermissions");
    expect(termReview()?.mode).toBe("bypassPermissions");
    requestTermReview("/repo/orbit", 1042, "apply");
    expect(termReview()?.mode).toBeUndefined();
    clearTermReview();
    expect(term).toMatch(/cmd: "review"[^\n]*mode: review\.mode/);
  });
});
