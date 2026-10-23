/*
 * The card door is documented where a person and an agent look: every verb is
 * named in the skill an agent reads, the route is in the API table, and the
 * switch that gates its acting verbs is in the configuration and the security
 * policy. A verb added to the server and not to these is a door nobody was told
 * about, which is how the list in `uiActions.ts` came to have a test of its own.
 */
import { describe, expect, test } from "bun:test";
import { DOOR_ACTING, DOOR_ACTING_LEVEL, DOOR_VERBS } from "../src/jiraDoor.ts";

const read = (p: string) => Bun.file(new URL(`../../${p}`, import.meta.url)).text();
const [skill, config, security] = await Promise.all([read("skills/ui-control/SKILL.md"), read("docs/CONFIG.md"), read("SECURITY.md")]);

describe("the Jira card door in the documents", () => {
  test("the skill names every verb as a CLI call and as an MCP tool", () => {
    for (const v of DOOR_VERBS) {
      expect(skill, `agentglass-ui jira ${v}`).toContain(`jira ${v}`);
      expect(skill, `ui_jira_${v}`).toContain(`ui_jira_${v}`);
    }
  });

  test("the API table lists the route with every verb", () => {
    const row = config.split("\n").find((l) => l.includes("POST /jira/door/"));
    expect(row).toBeDefined();
    for (const v of DOOR_VERBS) expect(row!, v).toContain(v);
  });

  test("the switch is in the configuration and the policy, and the policy says which verbs it gates", () => {
    expect(config).toContain("AGENTGLASS_JIRA_WRITE");
    expect(security).toContain("AGENTGLASS_JIRA_WRITE");
    const section = security.slice(security.indexOf("## Jira, and the agent door to a card"), security.indexOf("## Reading outside the open project"));
    expect(section.length).toBeGreaterThan(200);
    for (const v of DOOR_ACTING) expect(section, v).toContain(`\`${v}\``);
  });

  test("all three say the acting verbs need control level 3 as well as that switch", () => {
    const row = config.split("\n").find((l) => l.includes("POST /jira/door/"))!;
    const section = security.slice(security.indexOf("## Jira, and the agent door to a card"), security.indexOf("## Reading outside the open project"));
    const card = skill.slice(skill.indexOf("## A Jira card"));
    expect(row).toContain(`AGENTGLASS_CONTROL_LEVEL=${DOOR_ACTING_LEVEL}`);
    expect(section).toContain(`AGENTGLASS_CONTROL_LEVEL=${DOOR_ACTING_LEVEL}`);
    expect(card).toContain(`control level ${DOOR_ACTING_LEVEL}`);
    // The policy does not sell the door as a wall: the screen's routes take the same token.
    expect(section).toContain("POST /jira/step");
  });
});
