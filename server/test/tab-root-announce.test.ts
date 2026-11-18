/*
 * Every path that creates a tab with a cwd announces its root at birth: the
 * start verb, a policy-started worker and a resumed turn all end in
 * AgentOps.startAgent, so that is where the announcement lives. The behaviour
 * test states the seam; the anchor test fails if startAgent stops calling it
 * (a literal-source anchor, because a real start needs a tmux server).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { announceTabRoot, setRootAnnouncer } from "../src/agentops.ts";

describe("tab root announcement", () => {
  test("a registered announcer hears the note; a throwing one never fails the caller", () => {
    const heard: string[] = [];
    setRootAnnouncer((n) => heard.push(`${n.name}@${n.cwd}`));
    announceTabRoot({ name: "orbit-tab", paneId: "%64", cwd: "/code/orbit-ORBIT-1042" });
    expect(heard).toEqual(["orbit-tab@/code/orbit-ORBIT-1042"]);
    setRootAnnouncer(() => { throw new Error("boom"); });
    expect(() => announceTabRoot({ name: "x", paneId: "%1", cwd: "/code/orbit" })).not.toThrow();
    setRootAnnouncer(null);
  });

  test("startAgent announces on its success path, and the server registers the announcer", () => {
    const ops = readFileSync(new URL("../src/agentops.ts", import.meta.url), "utf8");
    const start = ops.slice(ops.indexOf("export async function startAgent"));
    expect(start).toContain("announceTabRoot({ name: p.name, paneId: opened.paneId, cwd: p.cwd })");
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(idx).toContain("AgentOps.setRootAnnouncer(");
  });
});
