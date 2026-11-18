/* The allow-list refusal names a way through the caller really has: a worker
   is refused `--shared`, so its text must never send it there. */
import { describe, expect, test } from "bun:test";
import { profileRefusal } from "../src/browserdrive.ts";

describe("profileRefusal", () => {
  test("a worker is told to ask for the setting, never --shared", () => {
    const msg = profileRefusal("acme-bot", ["orbit"], true);
    expect(msg).not.toContain("--shared");
    expect(msg).not.toContain("shared: true");
    expect(msg).toContain("orchestrator or the person");
    expect(msg).toContain('add "acme-bot" to Settings ▸ Browser ▸ Allowed profiles');
  });

  test("the person or the orchestrator keeps the --shared way", () => {
    const msg = profileRefusal("acme-bot", ["orbit"], false);
    expect(msg).toContain("Pass --shared");
    expect(msg).toContain('"acme-bot" is not in the allow-list (orbit)');
  });
});
