/*
 * The empty-list card's title, hint and retry offer — pulled out of Issues
 * and Tasks because both screens printed "Can't ask GitHub" / "Cannot read
 * the board" over the SAME underlying failure, `describeFailure`'s "Cannot
 * reach the computer", which is never the service's fault: the request
 * never left the phone's network. See src/lib/listError.ts.
 */
import { describe, expect, test } from "bun:test";
import { listErrorText } from "../src/lib/listError.ts";

describe("listErrorText", () => {
  test("no error: not the unreachable case", () => {
    expect(listErrorText(null)).toEqual({ title: null, hint: null, canRetry: false });
  });

  test("an unreachable computer is never blamed on the service it asked", () => {
    const got = listErrorText("Cannot reach the computer");
    expect(got.title).toBe("The computer is not answering");
    expect(got.title).not.toMatch(/GitHub|ClickUp/);
    expect(got.hint).not.toBeNull();
    expect(got.canRetry).toBe(true);
  });

  test("a service's own refusal is left to the screen's own copy", () => {
    expect(listErrorText("GitHub did not answer")).toEqual({ title: null, hint: null, canRetry: false });
    expect(listErrorText("ClickUp refused this token")).toEqual({ title: null, hint: null, canRetry: false });
  });
});
