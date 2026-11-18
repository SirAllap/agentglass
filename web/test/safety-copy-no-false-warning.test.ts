/*
 * A worker with network or docker on still runs under a read wall (bwrap hides the app's
 * credential dir), or the start is refused. So these switches must not claim the credential
 * becomes readable: that sentence was true before the wall and is false now.
 */
import { describe, expect, test } from "bun:test";
import { SAFETY } from "../src/components/orchestration/orchestrationCopy.ts";

describe("network and docker rows do not claim the credential is readable", () => {
  for (const k of ["network", "docker"] as const) {
    test(k, () => {
      expect(SAFETY[k]).not.toContain("can be read");
      expect(SAFETY[k]).not.toContain("~/.config/agentglass");
    });
  }
});
