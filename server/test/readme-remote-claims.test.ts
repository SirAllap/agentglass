/*
 * The README's remote-access section makes claims about code, and the claims
 * are the useful part.
 *
 * It tells people the hooks post to `http://localhost:4000` whatever a tunnel
 * is doing, that they refuse to send a transcript anywhere else, that
 * AGENTGLASS_ALLOW_REMOTE is the deliberate way out of that, and that
 * AGENTGLASS_ALLOWED_HOSTS is how a reverse-proxy name gets past the
 * DNS-rebinding guard. Every one of those is a thing somebody will act on while
 * deciding how to expose a server that can open a shell.
 *
 * Documentation naming an environment variable that no longer exists is worse
 * than none: it is followed confidently and does nothing. So each claim is
 * checked against the file that would have to change for it to stop being true.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repo = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const README = repo("README.md");

/** The part of the README this file is about, so a mention somewhere else does
 *  not satisfy a check about what the remote section says. */
const section = (() => {
  const from = README.indexOf("### Reaching it when you are not on the same wifi");
  expect(from, "the remote-access section is gone from the README").toBeGreaterThan(-1);
  return README.slice(from, README.indexOf("### Alerts that reach a locked phone", from));
})();

describe("what the README tells people about reaching this from elsewhere", () => {
  test("the escape hatch it names is the one the hooks actually read", () => {
    expect(section).toContain("AGENTGLASS_ALLOW_REMOTE");
    // The *read*, not a mention. Both hooks also name the variable in their
    // docstrings, so a check for the bare string passes against a hook that
    // documents it and no longer honours it — which is how mutation testing
    // found this check was not one.
    for (const hook of ["hooks/send_event.py", "hooks/gate_event.py"]) {
      expect(repo(hook), `${hook} no longer reads AGENTGLASS_ALLOW_REMOTE`)
        .toContain('os.environ.get("AGENTGLASS_ALLOW_REMOTE")');
    }
  });

  test("the address it says hooks post to is the address they default to", () => {
    // Quoted in the README because the mistake it prevents — pointing the hooks
    // at a public hostname — looks like the obvious thing to do once a tunnel
    // exists.
    expect(section).toContain("http://localhost:4000");
    expect(repo("hooks/send_event.py")).toContain('"http://localhost:4000"');
    expect(repo("hooks/gate_event.py")).toContain('"http://localhost:4000"');
  });

  test("the reverse-proxy variable it names is the one the guard reads", () => {
    expect(section).toContain("AGENTGLASS_ALLOWED_HOSTS");
    // Same trap: index.ts also names it in the 403 body it returns when the
    // guard fires, so the bare string survives the variable being renamed.
    expect(repo("server/src/index.ts")).toContain("process.env.AGENTGLASS_ALLOWED_HOSTS");
  });

  test("and it still says a tunnel is not the recommended answer", () => {
    // The section exists to be discouraging in a specific way: this server can
    // open a shell, so the recommendation is a private network rather than a
    // public hostname. A rewrite that loses that has lost the point of it.
    // The recommendation itself, not the word. "Tailscale" appears twice more
    // in this section — including in the sentence warning people off reaching
    // for a tunnel because Tailscale looked like more setup — so a check for
    // the name passes against a section that now recommends the opposite.
    expect(section).toContain("The honest answer is **Tailscale**");
    expect(section).toMatch(/open a shell/);
  });
});
