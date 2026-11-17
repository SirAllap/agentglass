/* The Jira board's Mine / Everyone choice: Mine by default, remembered. */
import { beforeAll, describe, expect, test, mock } from "bun:test";

const stored: Record<string, string> = {};
mock.module("expo-secure-store", () => ({
  getItemAsync: async (k: string) => stored[k] ?? null,
  setItemAsync: async (k: string, v: string) => { stored[k] = v; },
}));

let jiraScope: typeof import("../src/notifications/jiraScopePref.ts").jiraScope;
let setJiraScope: typeof import("../src/notifications/jiraScopePref.ts").setJiraScope;
let onJiraScope: typeof import("../src/notifications/jiraScopePref.ts").onJiraScope;

// A fresh copy: another test file may have loaded the module before the keystore was stubbed.
beforeAll(async () => {
  // The query string is not a real path to tsc, so the specifier is a plain string and the type comes from the import() types above.
  const spec: string = "../src/notifications/jiraScopePref.ts?fresh";
  ({ jiraScope, setJiraScope, onJiraScope } = (await import(spec)) as typeof import("../src/notifications/jiraScopePref.ts"));
});

describe("the Jira board scope", () => {
  test("defaults to Mine", () => {
    expect(jiraScope()).toBe("mine");
  });

  test("a choice is kept and told to subscribers", () => {
    let told = 0;
    const off = onJiraScope(() => { told++; });
    setJiraScope("everyone");
    expect(jiraScope()).toBe("everyone");
    expect(told).toBe(1);
    off();
  });
});
