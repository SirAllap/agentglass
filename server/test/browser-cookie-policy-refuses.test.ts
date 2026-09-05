/*
 * THE COOKIE POLICY THIS SHELL CANNOT SET.
 *
 * `ag:browserSessionSettings` took `cookies.thirdParty` and answered that it
 * had applied it. What it actually called was
 *
 *     ses.setVisitedLink({ options: { options: { thirdPartyPolicy: "block" } } })
 *
 * a method `Session` does not have, with a shape nothing in Electron takes —
 * so the call threw into the handler's catch (or did nothing at all) while
 * "cookies" went onto the list of things applied. Another verb answering
 * success and changing nothing, and the one the typecheck found the moment one
 * was run over `electron/`.
 *
 * There is nothing to call instead: Chromium decides third-party cookies from
 * the profile and its own flags, and Electron exposes neither at runtime. So
 * the answer is a refusal that says so, and this file is what keeps it a
 * refusal — asserted against the shipped source, because the handler needs an
 * Electron main process to run and the failure was never in its logic.
 */
import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
/* Delimited by the handler that follows it rather than by an offset: a fixed
   slice reads a different function the moment anything above it grows. */
const from = source.indexOf('ipcMain.handle("ag:browserSessionSettings"');
const whole = source.slice(from, source.indexOf("ipcMain.handle(", from + 40));
/* Comments quote the old call by name — the prose above the refusal says what
   it used to do — so an assertion about a word that must be ABSENT has to read
   the code alone. This repository has been caught by that twice. */
const handler = whole.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the third-party cookie setting", () => {
  test("no longer calls a method Session does not have", () => {
    expect(handler.length).toBeGreaterThan(100);
    /* Comments quote the old call by name; the check is that nothing CALLS it. */
    expect(handler).not.toContain("ses.setVisitedLink(");
  });

  test("is refused with a reason instead of reported as applied", () => {
    const refusal = handler.slice(handler.indexOf("req?.cookies"));
    expect(refusal).toContain("ok: false");
    expect(refusal).toContain("cookies.thirdParty cannot be set from here");
  });

  test("and \"cookies\" is never added to what was applied", () => {
    expect(handler).not.toContain('applied.push("cookies")');
  });

  test("while the settings that DO work are still applied", () => {
    expect(handler).toContain('applied.push("proxy")');
  });
});
