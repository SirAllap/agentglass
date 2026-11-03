/*
 * "Approve all" answers several requests with one click, so it must say which:
 * every waiting request is named in the row before the click, never a bare count.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/SettingsRequests.tsx", import.meta.url)).text();
const at = src.indexOf("function ApproveAll(");
const body = src.slice(at, src.indexOf("\n}\n", at));

describe("Approve all", () => {
  test("names every request it will approve", () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("requests.map((r) => r.label).join(\", \")");
  });
  test("is only offered when there is more than one", () => {
    expect(src).toContain("requests.length > 1 && <ApproveAll");
  });
});
