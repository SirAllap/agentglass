/*
 * What the docs say about the orchestration policy exists in the code.
 *
 * A route, a flag, a trigger or a facet named in a page that no longer exists
 * is a promise nobody can keep, and the page is read by the person deciding
 * what to switch on. So each name the pages use is looked for on both sides:
 * written in the prose, and present in the source that has to honour it.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../../${p}`, import.meta.url)).text();
const config = await read("docs/CONFIG.md");
const extending = await read("docs/EXTENDING.md");
const security = await read("SECURITY.md");
const skill = await read("skills/orchestrator/SKILL.md");
const index = await read("server/src/index.ts");
const cli = await read("bin/agentglass-agent");
const schema = await read("shared/orchestration.ts");
const kinds = await read("shared/agentKinds.ts");
const storage = await read("server/src/config.ts");
const policystart = await read("server/src/agents/policystart.ts");

/** The part of CONFIG.md that documents the policy. */
const policy = config.slice(config.indexOf("### The orchestration policy"), config.indexOf("### The CLIs in front of the API"));

describe("the routes the policy docs list are served", () => {
  /** What CONFIG.md writes, and how index.ts spells serving it: a path of its
   *  own, or a verb of `/seat/*`. */
  const routes: [string, string][] = [
    ["GET /orchestration?root=", 'pathname === "/orchestration" && req.method === "GET"'],
    ["POST /orchestration", 'pathname === "/orchestration" && req.method === "POST"'],
    ["GET /orchestration/state", 'pathname === "/orchestration/state"'],
    ["POST /seat/change", 'verb === "change"'],
  ];
  for (const [written, spelling] of routes) {
    test(written, () => {
      expect(config).toContain(`\`${written}`);
      expect(index).toContain(spelling);
    });
  }
});

describe("the CLI flags the docs and the skill name are the CLI's", () => {
  for (const flag of ["--role", "--engine", "--model", "--allow", "--cwd", "--prompt"]) {
    test(flag, () => {
      expect(policy).toContain(flag);
      expect(skill).toContain(flag);
      expect(cli).toContain(`"${flag}"`);
    });
  }
});

describe("the triggers and the config key are the schema's", () => {
  for (const kind of ["always", "usage", "limit", "hours", "budget"]) {
    test(kind, () => {
      expect(policy).toContain(`\`${kind}\``);
      expect(schema).toContain(`kind: "${kind}"`);
    });
  }
  test("the stored key", () => {
    expect(policy).toContain("`orchestration` key of `config.json`");
    expect(storage).toContain("orchestration?:");
  });
  test("the defaults quoted are the code's", () => {
    expect(schema).toContain("{ maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }");
    expect(policy).toContain("`3`, `30`, `1`");
  });
});

describe("the facets EXTENDING.md lists are the provider table's", () => {
  for (const facet of ["version", "account", "headless", "envelope", "screen"]) {
    test(facet, () => {
      expect(extending).toContain(`| \`${facet}\` |`);
      expect(kinds).toMatch(new RegExp(`\\b${facet}\\?: ${facet[0].toUpperCase()}${facet.slice(1)}Facet`));
    });
  }
  for (const via of ["settings-flag", "config-env", "sandbox-flags", "own-config"]) {
    test(`envelope via ${via}`, () => {
      expect(extending).toContain(`\`${via}\``);
      expect(kinds).toContain(`"${via}"`);
    });
  }
});

describe("the restart wording is the one the code writes", () => {
  test("ceiling lost: restarted", () => {
    expect(policystart).toContain('const LOST = "ceiling lost: restarted"');
    for (const page of [policy, security, skill]) expect(page).toContain("ceiling lost: restarted");
  });
});

describe("SECURITY.md states the ceiling, not a sandbox", () => {
  test("it says what the envelope is not", () => {
    expect(security).toContain("it is not a sandbox");
    expect(security).toContain("Orchestration: what is held, and what is not");
  });
});
