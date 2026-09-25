/*
 * The approval screen says what a scope is.
 *
 * A plugin's scope limits the token it is handed, not the process: the
 * entrypoint is a command this user runs, with this user's files. "Cannot
 * write anything" beside a plugin that can was the consent gate telling the
 * one lie it exists to prevent. The warning is asserted against the source
 * because there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(new URL("../src/components/plugins/PluginDeclaration.tsx", import.meta.url)).text();
const DOC = (await Bun.file(new URL("../../docs/PLUGINS.md", import.meta.url)).text()).replace(/\s+/g, " ");

describe("approval screen", () => {
  test("carries the process warning, whatever the scope", () => {
    expect(SRC).toContain("PROCESS_WARNING");
    expect(SRC).toMatch(/runs as you/i);
    expect(SRC).toMatch(/limits its access to this app, not to your machine/i);
  });

  test("the warning is drawn in the component, not only defined", () => {
    const i = SRC.indexOf("export function PluginDeclaration(");
    expect(i).toBeGreaterThan(0);
    expect(SRC.slice(i)).toContain("{PROCESS_WARNING}");
  });

  test("no scope sentence claims the plugin cannot write or touch the machine", () => {
    const sentences = SRC.slice(SRC.indexOf("const SCOPE_SENTENCE"), SRC.indexOf("const SCOPE_WORD"));
    expect(sentences).not.toMatch(/cannot[^.]*write anything/i);
    expect(sentences).not.toMatch(/touch this machine/i);
  });
});

describe("docs/PLUGINS.md", () => {
  test("says a plugin runs as the user and scope limits only the token", () => {
    expect(DOC).toMatch(/runs as you/i);
    expect(DOC).toMatch(/scope limits the token, not the process/i);
  });

  test("no longer promises a read plugin cannot write", () => {
    expect(DOC).not.toMatch(/Cannot write anything/);
  });
});
