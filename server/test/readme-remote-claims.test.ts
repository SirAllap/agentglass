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

/**
 * The README also promises the notification can be answered from the lock
 * screen, which is a promise about `web/public/sw.js`. A worker that stops
 * drawing the buttons is invisible — the alert still arrives, and only the
 * thing the README says it does is missing.
 */
describe("what the README promises about the notification", () => {
  const alerts = (() => {
    const from = README.indexOf("### Alerts that reach a locked phone");
    expect(from, "the alerts section is gone from the README").toBeGreaterThan(-1);
    return README.slice(from, README.indexOf("Independent of `AGENTGLASS_NOTIFY`", from));
  })();

  test("the buttons it names are the buttons the worker draws", () => {
    expect(alerts).toContain("Allow and Deny on the notification");
    const sw = repo("web/public/sw.js");
    expect(sw).toContain('{ action: "allow", title: "Allow" }');
    expect(sw).toContain('{ action: "deny", title: "Deny" }');
  });

  test("and it still says only a held gate gets them", () => {
    // The claim that keeps the feature from becoming a notification with
    // buttons on everything, which is the version nobody wants.
    expect(alerts).toMatch(/Only a held gate gets them/);
    expect(repo("web/public/sw.js")).toContain("actions: gate");
  });

  test("the tap-to-open path it points iPhone users at is still there", () => {
    expect(alerts).toContain("Safari draws no");
    expect(repo("web/public/sw.js")).toContain("openWindow");
  });
});

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
    //
    // The literal address matters as much as the claim: it is 127.0.0.1 rather
    // than localhost because the server binds IPv4-only, and a resolver that
    // answers ::1 first makes every event pay a refused connect. A README that
    // still said localhost would be documenting the slow path as the default.
    expect(section).toContain("http://127.0.0.1:4000");
    expect(repo("hooks/send_event.py")).toContain('"http://127.0.0.1:4000"');
    expect(repo("hooks/gate_event.py")).toContain('"http://127.0.0.1:4000"');
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
