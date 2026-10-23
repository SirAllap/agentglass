/*
 * A link a program prints with its own target (OSC 8) is followed like any
 * other link in the terminal, and only when it is http(s).
 *
 * xterm's own handler asks confirm() and opens a window the desktop shell
 * denies, so the link did nothing there. The terminal now hands the target to
 * the router. The case worth pinning is the refusal: whatever scheme a program
 * prints, the only thing that can open is a web page.
 */
import { describe, expect, it } from "bun:test";
import { oscLinkHandler } from "../src/lib/linkRouter.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const SOURCE = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url).pathname).text();

function opened(uri: string): string[] {
  const seen: string[] = [];
  stubGlobal("window", { open: (u: string) => { seen.push(u); return null; } });
  oscLinkHandler.activate({}, uri);
  return seen;
}

describe("an OSC 8 link in the terminal", () => {
  it("opens a web page", () => {
    expect(opened("https://docs.example.com/guide")).toEqual(["https://docs.example.com/guide"]);
  });

  it("opens nothing that is not http(s)", () => {
    for (const uri of ["javascript:void(0)", "file:///etc/hosts", "data:text/html,x", "vscode://open", "ssh://host", "not a url"]) {
      expect(opened(uri), uri).toEqual([]);
    }
  });

  it("does not ask xterm to offer other schemes", () => {
    expect(oscLinkHandler.allowNonHttpProtocols).toBe(false);
  });

  it("is the handler the terminal is built with", () => {
    expect(SOURCE).toMatch(/new Terminal\(\{[\s\S]*?linkHandler: oscLinkHandler,[\s\S]*?\}\);/);
  });
});
