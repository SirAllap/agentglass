/*
 * "Reinstall the app to get it" is advice for a machine with an installer.
 *
 * A .dmg has none: the CLI ships inside the bundle at
 * agentglass.app/Contents/Resources/bin and nothing puts that on PATH, so the
 * Agent browser use pane on a Mac told people to reinstall an app that already
 * had the file. The pane now says where the file is and the two ways to reach
 * it from a shell, and says so only on the Mac desktop — the Linux line still
 * names the installer, which is right there.
 *
 * Source-shape, like the other Settings suites: the pane is a component with a
 * server behind it, and the sentence is the whole change.
 */
import { describe, expect, it } from "bun:test";

const pane = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

describe("the browser CLI line on a Mac", () => {
  const start = pane.indexOf("const cliSays =");
  const block = pane.slice(start, pane.indexOf(";", pane.indexOf("reinstall the app to get it", start)));

  it("is gated on the Mac desktop, not on the platform the browser reports", () => {
    expect(block).toContain("IS_MAC_DESKTOP");
    expect(pane).toMatch(/import \{[^}]*\bIS_MAC_DESKTOP\b[^}]*\} from "\.\.\/lib\/desktop\.ts"/);
  });

  it("names the bundle path and both ways onto PATH", () => {
    expect(pane).toContain('const MAC_BUNDLE_BIN = "/Applications/agentglass.app/Contents/Resources/bin";');
    expect(block).toContain("${MAC_BUNDLE_BIN}/agentglass-browser");
    expect(block).toContain("add ${MAC_BUNDLE_BIN} to your PATH");
    expect(block).toContain("ln -s ${MAC_BUNDLE_BIN}/agentglass-browser ${st.cli.path}");
  });

  it("keeps the installer sentence for everybody else", () => {
    expect(block).toContain("The installer puts it at ${st.cli.path}; reinstall the app to get it.");
  });
});
