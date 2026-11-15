import { expect, test } from "bun:test";
import { isRuleRoot, rulePathSpelling } from "../src/agentRulesPath.ts";

test("absolute POSIX, drive-letter and complete UNC roots", () => {
  for (const root of ["*", "/", "/work/orbit", "D:/code/orbit", "D:\\code\\orbit", "D:/", "\\\\server\\share\\orbit", "//server/share/orbit"]) expect(isRuleRoot(root), root).toBe(true);
  expect(isRuleRoot("*", false)).toBe(false);
});

test("relative, drive-relative, traversal and NUL inputs are refused", () => {
  for (const root of [null, 4, "", "orbit", "../orbit", "D:orbit", "D:", "\\orbit", "\\\\server", "\\\\?\\D:\\orbit", "/work/../orbit", "D:/code/../orbit", "D:\\code\\..\\orbit", "D:/code\\..\\orbit", "/work/./orbit", "/work\0/orbit"]) expect(isRuleRoot(root), String(root)).toBe(false);
});

test.if(process.platform === "win32")("Windows scopes use one native spelling and preserve drive roots", () => {
  expect(rulePathSpelling("D:\\code\\orbit\\")).toBe("D:\\code\\orbit");
  expect(rulePathSpelling("D:/code/orbit/")).toBe("D:\\code\\orbit");
  expect(rulePathSpelling("//server/share/orbit")).toBe("\\\\server\\share\\orbit");
  expect(rulePathSpelling("D:/")).toBe("D:\\");
  expect(rulePathSpelling("/")).toBe("/");
});

// Importing index.ts would start its listeners and background tasks.
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const store = await Bun.file(new URL("../src/agentRulesStore.ts", import.meta.url)).text();
test("read, write and hook check entry points use the shared root guard", () => {
  expect(index).toContain('if (!isRuleRoot(root)) return json(');
  expect(index).toContain('if (!isRuleRoot(root, false) ||');
  expect(store).toContain('if (!isRuleRoot(b.root)) return');
});