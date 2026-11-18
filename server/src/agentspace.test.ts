import { test, expect } from "bun:test";
import { agentSession, agentSpaceRoot } from "./agentops.ts";

const fold = (m: Record<string, string>) => (d: string) => m[d] ?? null;

test("a sibling worktree opens in its project's session, not its own", () => {
  const r = agentSpaceRoot("/code/orbit", "/code/orbit-ORBIT-1042", fold({ "/code/orbit-ORBIT-1042": "/code/orbit" }));
  expect(agentSession(r)).toBe("orbit");
});

test("a foreign project's worktree never lands in the open project's session", () => {
  const r = agentSpaceRoot("/code/orbit", "/wt/ab12/thing", fold({ "/wt/ab12/thing": "/code/acme" }));
  expect(agentSession(r)).toBe("acme");
  expect(agentSession(r)).not.toBe("orbit");
});

test("unresolvable cwd or a throwing resolver falls back to the given root", () => {
  expect(agentSpaceRoot("/code/orbit", "/x", () => null)).toBe("/code/orbit");
  expect(agentSpaceRoot("/code/orbit", "/x", () => { throw new Error("no git"); })).toBe("/code/orbit");
});

import { pickAgentSession } from "./agentops.ts";
import { readFileSync } from "node:fs";

test("project session exists: used", () => {
  expect(pickAgentSession("acme", (s) => s === "acme", "scratch")).toBe("acme");
});
test("project session missing: the person's session, never a new one", () => {
  expect(pickAgentSession("orbit-ORBIT-1042", (s) => s === "scratch", "scratch")).toBe("scratch");
});
test("no valid person session: project name (tmux needs one)", () => {
  expect(pickAgentSession("orbit", () => false, "scratch")).toBe("orbit");
  expect(pickAgentSession("orbit", () => true, "agx-phone-1")).toBe("orbit");
});
test("start path never calls new-session itself", () => {
  const src = readFileSync(new URL("./agentops.ts", import.meta.url), "utf8");
  const start = src.slice(src.indexOf("export async function startAgent"));
  expect(start.includes("new-session")).toBe(false);
  expect(start).toContain("agentSessionFor(");
});

test("a resumed turn passes its tab's current session to startAgent, and startAgent honours it", () => {
  const ps = readFileSync(new URL("./agents/policystart.ts", import.meta.url), "utf8");
  expect(ps.match(/session: home,/g)?.length).toBe(2);
  expect(ps.match(/const home = await AgentOps\.sessionOfWindow\(a\.windowId\);/g)?.length).toBe(2);
  const ops = readFileSync(new URL("./agentops.ts", import.meta.url), "utf8");
  expect(ops).toContain("p.session || await agentSessionFor(");
});
