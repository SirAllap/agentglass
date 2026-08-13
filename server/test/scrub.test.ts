// The scrubber's guarantee is the point (#207): feed it realistic dirty inputs
// and prove none of the user's data survives. These are property-style — a
// battery of forbidden substrings (a username, private project names, tokens,
// home paths, a payload) that must appear NOWHERE in the emitted SafeReport —
// not just a couple of examples.
import { describe, expect, test } from "bun:test";
import { scrub, redactText, type SafeReport } from "../../shared/scrub.ts";

// Everything here is a thing a real agentglass error could carry and that must
// never leave the machine.
const FORBIDDEN = [
  "ada", // the OS username, leaked by every /home/<user>/ path
  "orbit", // a private project name, leaked by a repo path
  "ghp_" + "AbCdEf0123456789AbCdEf", // a GitHub token
  "sk-" + "abcdef0123456789abcdef", // an API key
  "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6", // a JWT prefix
  "write me a function that", // a prompt fragment
  "/home/ada", // a home path
  "/Users/ada", // a mac home path
];

function assertClean(report: SafeReport) {
  const blob = JSON.stringify(report);
  for (const bad of FORBIDDEN) expect(blob).not.toContain(bad);
}

describe("scrub — no user data survives", () => {
  test("a stack trace full of user paths keeps only app frames, leaking no identity", () => {
    const err = new Error("Cannot read properties of undefined (reading 'x')");
    err.stack = [
      "TypeError: Cannot read properties of undefined",
      "    at derive (/home/ada/code/agentglass/server/src/derive.ts:42:9)",
      "    at handler (/home/ada/code/orbit/private/secret-service.ts:7:3)",
      "    at load (/home/ada/.claude/plugins/thing.js:1:1)",
      "    at run (/home/ada/code/agentglass/node_modules/react-dom/index.js:9:9)",
      "    at web (/home/ada/code/agentglass/web/src/App.tsx:100:5)",
    ].join("\n");
    const r = scrub({ error: err });
    assertClean(r);
    // The two app frames survive, app-relative; the user-repo, ~/.claude and
    // node_modules frames are gone.
    expect(r.frames.join("\n")).toContain("server/src/derive.ts");
    expect(r.frames.join("\n")).toContain("web/src/App.tsx");
    expect(r.frames.some((f) => f.includes("orbit") || f.includes("node_modules") || f.includes(".claude"))).toBe(false);
    expect(r.frames.length).toBe(2);
  });

  test("secrets in the message are redacted, whatever their shape", () => {
    const err = new Error(
      "auth failed: Bearer ghp_AbCdEf0123456789AbCdEf and key sk-abcdef0123456789abcdef and jwt eyJhbGciOiJIUzI1NiIsInR5cCI6.body.sig",
    );
    const r = scrub({ error: err });
    assertClean(r);
    expect(r.message).toContain("<redacted-secret>");
  });

  test("a token buried in a home path is caught and the path is dropped", () => {
    const r = scrub({ error: "read /home/ada/.claude/creds with sk-abcdef0123456789abcdef" });
    assertClean(r);
  });

  test("extra properties the error carries (a prompt payload, a file slice) are dropped, not read", () => {
    const err = new Error("JSON parse error") as Error & Record<string, unknown>;
    err.prompt = "write me a function that deletes /home/ada/code/orbit";
    err.userFile = "/home/ada/code/orbit/secret.ts";
    err.env = { OPENAI_API_KEY: "sk-abcdef0123456789abcdef" };
    const r = scrub({ error: err });
    assertClean(r);
    expect(r.message).toBe("JSON parse error"); // only the message came through
  });

  test("windows home paths are redacted too", () => {
    const r = scrub({ error: "ENOENT: C:\\Users\\ada\\code\\orbit\\app.log not found" });
    assertClean(r);
  });
});

describe("scrub — the allowlist is exactly what it emits", () => {
  test("only the allowlisted top-level keys appear", () => {
    const r = scrub({ error: new Error("x"), category: "diff viewer", app: { version: "0.5.0", commit: "abc1234" }, runtime: { os: "linux", arch: "x64", bun: "1.3.9", electron: "33.4.11" } });
    expect(new Set(Object.keys(r))).toEqual(new Set(["errorType", "message", "frames", "category", "app", "runtime"]));
    expect(r.app).toEqual({ version: "0.5.0", commit: "abc1234" });
    expect(r.runtime).toEqual({ os: "linux", arch: "x64", bun: "1.3.9", electron: "33.4.11" });
    expect(r.category).toBe("diff viewer");
    expect(r.errorType).toBe("Error");
  });

  test("injection characters in the safe context are stripped (it is metadata, not markup)", () => {
    const r = scrub({ error: new Error("x"), category: "diff</script> viewer\n<b>x", app: { version: "0.5.0 && rm -rf ~" } });
    assertClean(r);
    expect(r.category).not.toContain("<");
    expect(r.category).not.toContain(">");
    expect(r.category).not.toContain("\n");
    expect(r.app.version).not.toContain("&"); // shell metacharacters gone
  });

  test("a bare string error and a missing stack are handled", () => {
    const r = scrub({ error: "GET /home/ada/x failed" });
    assertClean(r);
    expect(r.errorType).toBe("Error");
    expect(r.frames).toEqual([]);
  });

  test("redactText leaves app paths app-relative and drops the rest", () => {
    expect(redactText("at /home/ada/code/agentglass/server/src/db.ts:5")).toContain("server/src/db.ts");
    expect(redactText("opened /home/ada/code/orbit/x.ts")).not.toContain("orbit");
    expect(redactText("read/write ratio is fine")).toBe("read/write ratio is fine"); // prose slash left alone
  });
});
