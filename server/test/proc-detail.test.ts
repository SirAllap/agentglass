/*
 * The environment of a process, and why most of it must arrive masked.
 *
 * `/proc/<pid>/environ` is where the explanation for a stray process lives — a
 * server on 0.0.0.0 was explained on this machine by one inherited variable —
 * and it is also where tokens, API keys and database passwords live. The panel
 * that shows it is reachable from a paired phone.
 *
 * So these tests care much more about what is HIDDEN than about what is shown.
 * A wrongly masked PATH costs a click. A wrongly revealed key is on a phone
 * screen and in whatever screenshot follows.
 */
import { describe, expect, test } from "bun:test";
import { looksSecret, procDetail, revealEnv } from "../src/procdetail.ts";

describe("what counts as a secret", () => {
  test("the names that carry credentials", () => {
    const masked = [
      ["AGENTGLASS_TOKEN", "qMbDRMJG-CgT047W8HTg"],
      ["AWS_SECRET_ACCESS_KEY", "abc"],
      ["GITHUB_TOKEN", "ghp_x"],
      ["DATABASE_PASSWORD", "hunter2"],
      ["MY_PRIVATE_KEY", "x"],
      ["SESSION_ID", "x"],
      ["SENTRY_DSN", "https://k@sentry.io/1"],
      ["GH_PAT", "x"],
      ["npm_config__authToken", "x"],
    ];
    for (const [k, v] of masked) expect(looksSecret(k!, v!), `${k} should be masked`).toBe(true);
  });

  test("the ones that explain a process, and must stay readable", () => {
    // These are the whole reason the panel exists. Masking them would leave a
    // list of names and no answer.
    const plain = [
      ["AGENTGLASS_BIND", "0.0.0.0"],
      ["AGENTGLASS_PORT", "4000"],
      ["NODE_ENV", "development"],
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
      ["PWD", "/home/u/code/repo"],
      ["LANG", "en_GB.UTF-8"],
    ];
    for (const [k, v] of plain) expect(looksSecret(k!, v!), `${k} should be readable`).toBe(false);
  });

  test("the session and private words have to earn it", () => {
    /*
     * Tuned against a real process rather than guessed, and this is the tuning.
     * Bare `SESSION`, `AUTH` and `PRIVATE` masked eighteen of seventy-seven
     * variables, of which two were secrets: `DESKTOP_SESSION=ubuntu`,
     * `XDG_SESSION_TYPE=wayland`, `GDMSESSION`. A panel where everything is
     * dots teaches people to click through the dots.
     */
    expect(looksSecret("SESSION_TOKEN", "x")).toBe(true);
    expect(looksSecret("XDG_SESSION_TYPE", "wayland")).toBe(false);
    expect(looksSecret("DESKTOP_SESSION", "ubuntu")).toBe(false);
    expect(looksSecret("PRIVATE_KEY", "x")).toBe(true);
    expect(looksSecret("PRIVATE_TMP", "1")).toBe(false);
  });

  test("a path TO a credential is not the credential", () => {
    // The other half of the noise, and an ordering bug: the name was checked
    // before the value, so all three of these were masked and taught nobody
    // anything.
    expect(looksSecret("SSH_AUTH_SOCK", "/run/user/1000/keyring/ssh")).toBe(false);
    expect(looksSecret("XAUTHORITY", "/run/user/1000/.mutter-Xwaylandauth.ABC123")).toBe(false);
    expect(looksSecret("SESSION_MANAGER", "local/host:@/tmp/.ICE-unix/3919")).toBe(false);
  });

  test("but a URL carrying its own credentials is still a secret", () => {
    // Not a corner case: a Sentry DSN and a database URL both put the key in
    // the userinfo. Exempting every URL as "a location" would hand those over
    // in full, so an `@` disqualifies it.
    expect(looksSecret("SENTRY_DSN", "https://abc123@sentry.io/1")).toBe(true);
    expect(looksSecret("DATABASE_URL", "postgres://u:p@db.internal/app")).toBe(true);
    expect(looksSecret("API_BASE", "https://api.example.com/v1")).toBe(false);
  });

  test("a credential-shaped value is masked whatever the key is called", () => {
    // The long tail: a variable somebody named `X`, or a token under a name no
    // pattern anticipated.
    // Deliberately not a real vendor's prefix. This carried Stripe's own
    // published sample key, and GitHub's secret scanning refused the push --
    // correctly, because it cannot tell a documentation sample from a live
    // key, and neither can the next reader. The assertion needs a value that
    // is credential-SHAPED; any high-entropy run of that length is one, and
    // the vendor prefix was never what made it pass.
    expect(looksSecret("X", "tok_zq7Xn4Rm2vLpKd8Ws3Yb6Hj1")).toBe(true);
    expect(looksSecret("BUILD", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
  });

  test("a long path is not a credential", () => {
    // Density alone is not the test — a PATH is long and dense and is the most
    // useful line on the panel.
    expect(looksSecret("LD_LIBRARY_PATH", "/usr/lib/x86_64-linux-gnu:/usr/local/lib")).toBe(false);
  });

  test("prose is not a credential", () => {
    expect(looksSecret("GREETING", "hello there this is a long sentence")).toBe(false);
  });

  test("a short value under an innocent name stays visible", () => {
    expect(looksSecret("TERM", "xterm-256color")).toBe(false);
  });
});

describe("reading one process", () => {
  test("our own, in full", () => {
    // The test process is the one process we can be certain about.
    const d = procDetail(process.pid);
    expect(d.error).toBeUndefined();
    expect(d.pid).toBe(process.pid);
    expect(d.cmd.length).toBeGreaterThan(0);
    expect(d.env.length).toBeGreaterThan(0);
    // Started by whatever ran the suite, so there is always at least a parent.
    expect(Array.isArray(d.ancestry)).toBe(true);
  });

  test("every masked variable comes back with null, not with its value", () => {
    // The assertion the whole module exists for.
    const d = procDetail(process.pid);
    for (const v of d.env) {
      if (v.masked) expect(v.value, `${v.key} leaked its value`).toBeNull();
    }
  });

  test("an empty value is a value, not a mask", () => {
    // `null` is the signal for "hidden". An environment variable set to the
    // empty string is a real and different thing, and conflating them would
    // make the panel say "secret" about a variable that is simply blank.
    const d = procDetail(process.pid);
    const blanks = d.env.filter((v) => v.value === "");
    for (const v of blanks) expect(v.masked).toBe(false);
  });

  test("keys are always listed, even when values are not", () => {
    // That AGENTGLASS_BIND is *set* is the answer; its value is a detail. A
    // panel that hid the names would hide the explanation with them.
    const d = procDetail(process.pid);
    for (const v of d.env) expect(v.key.length).toBeGreaterThan(0);
  });

  test("somebody else's process is refused rather than half-answered", () => {
    // pid 1 is init: reliably present, reliably not ours.
    const d = procDetail(1);
    expect(d.error).toBeTruthy();
    expect(d.env).toEqual([]);
  });

  test("nonsense in, refusal out", () => {
    for (const bad of [null, undefined, "abc", -1, 0, {}]) {
      expect(procDetail(bad).error, `${String(bad)}`).toBeTruthy();
    }
  });
});

describe("unmasking one", () => {
  test("returns the real value for a variable we own", () => {
    const d = procDetail(process.pid);
    const known = d.env.find((v) => v.key === "PATH");
    expect(known).toBeDefined();
    const r = revealEnv(process.pid, "PATH");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(process.env.PATH);
  });

  test("a variable that is not set is not invented", () => {
    expect(revealEnv(process.pid, "AGX_NO_SUCH_VARIABLE_HERE").ok).toBe(false);
  });

  test("somebody else's process is refused", () => {
    expect(revealEnv(1, "PATH").ok).toBe(false);
  });

  test("nonsense in, refusal out", () => {
    expect(revealEnv(process.pid, "").ok).toBe(false);
    expect(revealEnv(process.pid, null).ok).toBe(false);
    expect(revealEnv("nope", "PATH").ok).toBe(false);
  });
});
