/*
 * `permission` COULD NOT GRANT ANYTHING ON A DEFAULT INSTALL.
 *
 * Measured on the running app:
 *
 *     $ agentglass-browser permission http://127.0.0.1:8899 clipboardReadWrite
 *     origin http://127.0.0.1:8899 is not in AGENTGLASS_BROWSER_ORIGINS (*)
 *
 * Nothing is not in `*`. The check was `list.includes(host)` — a raw
 * membership test — while the rule for this list lives three hundred lines
 * above in `originAllowed`, which handles both `*` and the documented bare
 * hostname ("an entry with no `:` matches the hostname on any port").
 *
 * It made `clipboard` unreachable too, since its own refusal says "grant
 * clipboardReadWrite with `permission` first" — a door whose key was behind
 * the door.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseAsk } from "../src/browserdrive.ts";

const was = process.env.AGENTGLASS_BROWSER_ORIGINS;
afterEach(() => {
  if (was === undefined) delete process.env.AGENTGLASS_BROWSER_ORIGINS;
  else process.env.AGENTGLASS_BROWSER_ORIGINS = was;
});

const ask = (origin: string) => parseAsk("permission", { origin, permissions: ["clipboardReadWrite"] });

describe("granting a permission", () => {
  test("the default list allows every origin, as it says it does", () => {
    delete process.env.AGENTGLASS_BROWSER_ORIGINS;
    expect(ask("http://127.0.0.1:8899")).not.toHaveProperty("error");
    expect(ask("https://example.com")).not.toHaveProperty("error");
  });

  test("a bare hostname in the list matches any port on it", () => {
    /* The list's own documented rule, and the second thing a raw `includes`
       got wrong. */
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost";
    expect(ask("http://localhost:8001")).not.toHaveProperty("error");
    expect(ask("http://localhost")).not.toHaveProperty("error");
  });

  test("and an origin outside the list is still refused", () => {
    /* The fence is the point — granting the camera to a site the browser may
       not visit would be a gate beside it. */
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8001";
    const out = ask("https://example.com") as { error?: string };
    expect(out.error).toContain("not in AGENTGLASS_BROWSER_ORIGINS");
    /* Same host, wrong port, when the entry names a port. */
    expect(ask("http://localhost:9999")).toHaveProperty("error");
    expect(ask("http://localhost:8001")).not.toHaveProperty("error");
  });

  test("something that is not a URL is refused rather than let through", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "*";
    expect(ask("not a url")).toHaveProperty("error");
  });
});

/* An agent's answer to what its own tab is holding (`permission grant|deny`):
   the relay checks the shape and nothing wider gets through it. */
describe("answering a held request", () => {
  const answer = (body: object) => parseAsk("permission", body) as { ask?: { args: Record<string, unknown> }; error?: string };

  test("grant or deny of the microphone, the camera or notifications passes, with or without a site", () => {
    delete process.env.AGENTGLASS_BROWSER_ORIGINS;
    expect(answer({ answer: "grant", permissions: ["microphone"] }).ask?.args).toMatchObject({ answer: "grant", permissions: ["microphone"] });
    expect(answer({ answer: "deny", permissions: ["camera", "notifications"], origin: "http://localhost:8002" }).ask?.args)
      .toMatchObject({ answer: "deny", origin: "http://localhost:8002" });
    expect(answer({ list: true }).ask?.args).toMatchObject({ list: true });
  });

  test("anything else an agent might grant itself is refused", () => {
    delete process.env.AGENTGLASS_BROWSER_ORIGINS;
    for (const permissions of [["geolocation"], ["clipboardReadWrite"], ["microphone", "midi"], [], "microphone"]) {
      expect(answer({ answer: "grant", permissions }), JSON.stringify(permissions)).toHaveProperty("error");
    }
    expect(answer({ answer: "allow", permissions: ["microphone"] })).toHaveProperty("error");
  });

  test("a site named ahead of the ask is held to the origin list", () => {
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:8002";
    expect(answer({ answer: "grant", permissions: ["microphone"], origin: "http://localhost:8002" })).not.toHaveProperty("error");
    expect(answer({ answer: "grant", permissions: ["microphone"], origin: "https://example.com" })).toHaveProperty("error");
    expect(answer({ answer: "grant", permissions: ["microphone"], origin: "file:///etc" })).toHaveProperty("error");
  });
});
