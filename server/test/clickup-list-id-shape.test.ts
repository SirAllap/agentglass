// A Jira card's project key (ORBIT) reached `/clickup/list` as a list id and
// was passed on to ClickUp, which refused it, every few seconds.
import { expect, test } from "bun:test";

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

test("the list route refuses what cannot be a ClickUp list id before it spends a call", () => {
  const at = index.indexOf('if (pathname === "/clickup/list") {');
  expect(at).toBeGreaterThan(-1);
  const body = index.slice(at, index.indexOf("\n    }\n", at));
  const guard = body.indexOf("if (!clickupListIdShape(listId)) return json(");
  expect(guard).toBeGreaterThan(-1);
  expect(body.indexOf("await listMeta(token, listId)")).toBeGreaterThan(guard);
});
