/*
 * The Jira connection form, asserted against source (there is no renderer here).
 *
 * Three things matter and each is a way to leak or to break the other tracker:
 * the token field never shows what is typed, Jira connects through its own
 * route (the generic one takes a token alone and cannot check a site), and the
 * ClickUp-only controls stay ClickUp's.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();

/** The ProviderCard function, to its own closing brace. */
const card = (() => {
  const at = src.indexOf("function ProviderCard(");
  const end = src.indexOf("\nfunction RequirementsPane(", at);
  expect(at).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
})();
const code = card.split("\n").filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)).join("\n");

describe("the Jira connection form", () => {
  test("the token is typed into a password field and the form is cleared on success", () => {
    expect(code).toMatch(/<input type="password" value=\{token\}/);
    expect(code).toContain('setToken(""); setEmail(""); setSite("");');
  });

  test("Jira connects through its own call and never through the generic token door", () => {
    expect(code).toContain("api.jiraConnect(email.trim(), site.trim(), token.trim())");
    const generic = code.split("\n").filter((l) => l.includes("api.providerConnect("));
    expect(generic.length).toBe(1);
    // That one line is the other branch of the ternary on `isJira`.
    expect(code.indexOf("api.jiraConnect(")).toBeLessThan(code.indexOf("api.providerConnect("));
    expect(code).toContain("isJira\n      ? await api.jiraConnect");
  });

  test("the site is required, the email is not (a personal access token has none)", () => {
    expect(code).toContain("const ready = !!token.trim() && (!isJira || !!site.trim());");
  });

  test("the workspace picker is ClickUp's alone", () => {
    expect(code).toContain('connected && spec.id === "clickup" && (');
  });

  test("the client has a call and a demo twin for each route, and none sends the token anywhere but the body", () => {
    for (const name of ["jiraConnect", "jiraStatus", "jiraWrites"]) {
      expect(api.split(`${name}:`).length - 1, name).toBe(2);
    }
    expect(api).toContain('post<JiraConnectResult>("/jira/connect", { email, site, token })');
    expect(api).not.toMatch(/\/jira\/[a-z]+\?[^"`]*token/);
  });
});
