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
import { docSection, allDocs } from "./docs.ts";

const repo = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

/** The section of the README this file is about, so a mention somewhere else
 *  does not satisfy a check about what the remote section says. */
const ALERTS_HEADING = "### Alerts on the phone, and what they honestly cover";

const section = docSection("### Reaching it when you are not on the same wifi", ALERTS_HEADING);

/**
 * The README used to promise a notification answerable from the lock screen,
 * which was a promise about `web/public/sw.js` — and those checks read that
 * worker. Web Push is gone: no worker registers, no route hands out a VAPID
 * key, and the phone app raises a LOCAL notification from the alert frame on
 * the socket it already holds.
 *
 * So the claim to check is the new one, and it is the more important kind:
 * "there is no third party in this path" is a privacy statement, and a route
 * quietly coming back would make it false while the README went on saying it.
 */
describe("what the README promises about an alert reaching a phone", () => {
  const alerts = docSection(ALERTS_HEADING, "\n---");

  test("the frame it names is the one the server actually broadcasts", () => {
    expect(alerts).toContain('`{type:"alert"}`');
    expect(repo("shared/types.ts")).toContain('type: "alert"');
    // Same call for every attached client. The README's claim that the phone
    // gets "the identical frame the desk turns into a native notification" is
    // true only while there is one broadcast rather than a phone-shaped copy.
    //
    // A PREFIX, and the count below is what actually carries the claim. Pinning
    // the whole argument list pinned one branch's version of the frame: this
    // was written as `{ title, body, urgency })` while, on the other branch,
    // the same call had already grown `...(pane ? { pane } : {})` — where the
    // agent is, for the one client that can act on it. The two met here and the
    // test failed over a field that makes the frame richer for everybody, which
    // is the opposite of what it exists to catch.
    expect(repo("server/src/alerts.ts")).toContain("sink.broadcast({ title, body, urgency");
    // The real assertion: ONE broadcast. A phone-shaped copy would be a second.
    expect(repo("server/src/alerts.ts").match(/sink\.broadcast\(/g)).toHaveLength(1);
  });

  test("and no push route it says is gone is still being served", () => {
    // Across the whole of the documentation, not one file of it: the promise
    // is that this route does not exist, so a page reintroducing it anywhere
    // is the thing worth catching.
    for (const { path, text } of allDocs()) expect(text, `${path} mentions a push route again`).not.toContain("/push/");
    expect(repo("server/src/index.ts")).not.toContain('pathname === "/push');
    // The switch that turned it on was in the deleted companion, so a route
    // left behind would be reachable by nothing but a stranger with the token.
    expect(repo("server/src/alerts.ts")).not.toContain("pushEveryone");
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
