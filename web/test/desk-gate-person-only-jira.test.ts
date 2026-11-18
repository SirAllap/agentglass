import { describe, expect, test } from "bun:test";
import { deskGated } from "../src/lib/deskGate.ts";
import { PERSON_ONLY_JIRA_ROUTES } from "../../shared/personOnlyJiraRoutes.ts";

/* The server reads a Jira write without the desk key as an agent's and refuses it.
   Every person-only route must be desk-gated, or the window's own click fails. */
describe("person-only Jira routes carry the desk key", () => {
  for (const p of PERSON_ONLY_JIRA_ROUTES) test(p, () => expect(deskGated(p)).toBe(true));
});
