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

/** Jira's own page: the form lives there now, not in Tools & services. */
const page = await Bun.file(new URL("../src/components/JiraPane.tsx", import.meta.url)).text();
const code = page.split("\n").filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)).join("\n");

describe("the Jira connection form", () => {
  test("the token is typed into a password field and the form is cleared on success", () => {
    expect(code).toMatch(/<input id="jira-token" type="password" value=\{token\}/);
    expect(code).toContain('setToken(""); setEmail(""); setSite("");');
  });

  test("Jira connects through its own call and never through the generic token door", () => {
    expect(code).toContain("api.jiraConnect(email.trim(), site.trim(), token.trim())");
    expect(code).not.toContain("api.providerConnect(");
  });

  test("the site is required, the email is not (a personal access token has none)", () => {
    expect(code).toContain("const ready = !!token.trim() && !!site.trim();");
  });

  test("the workspace picker is ClickUp's alone", () => {
    const card = src.slice(src.indexOf("function ProviderCard("), src.indexOf("\nfunction RequirementsPane("));
    expect(card).toContain('connected && spec.id === "clickup" && (');
  });

  test("the client has a call and a demo twin for each route, and none sends the token anywhere but the body", () => {
    for (const name of ["jiraConnect", "jiraStatus", "jiraWrites"]) {
      expect(api.split(`${name}:`).length - 1, name).toBe(2);
    }
    expect(api).toContain('post<JiraConnectResult>("/jira/connect", { email, site, token })');
    expect(api).not.toMatch(/\/jira\/[a-z]+\?[^"`]*token/);
  });
});
