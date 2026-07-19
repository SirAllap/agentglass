// Guards on the functions where a regression = RCE or a path escape: the
// origin/rebinding address parser, the repo-path boundary, the shell-safe
// relative-path filter, the Makefile-target parser, and the token check.
import { describe, expect, test } from "bun:test";
import { privateHost } from "../src/net.ts";
import { safeAbs } from "../src/git.ts";
import { shellSafeRel, parseMakeTargets } from "../src/terminal.ts";
import { tokenOk, isAuthExempt, isIntake } from "../src/auth.ts";

describe("privateHost", () => {
  test("loopback is always trusted, regardless of trustLan", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "foo.localhost", "127.9.9.9"]) {
      expect(privateHost(h, false)).toBe(true);
      expect(privateHost(h, true)).toBe(true);
    }
  });

  test("a name that merely looks private is NOT trusted (rebinding defense)", () => {
    // These are hostnames an attacker can register and point at 127.0.0.1.
    for (const h of ["10.evil.com", "192.168.1.1.nip.io", "notlocalhost", "evil.com"]) {
      expect(privateHost(h, true)).toBe(false);
    }
  });

  test("RFC1918 ranges are gated by trustLan", () => {
    for (const h of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "172.31.255.255"]) {
      expect(privateHost(h, false)).toBe(false); // loopback-only by default
      expect(privateHost(h, true)).toBe(true); // opted into LAN
    }
  });

  test("public and near-miss addresses are never private", () => {
    for (const h of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(privateHost(h, true)).toBe(false);
    }
  });

  test("IPv6 unique-local gated by trustLan; ::1 always", () => {
    expect(privateHost("fc00::1", false)).toBe(false);
    expect(privateHost("fd12:3456::1", true)).toBe(true);
    expect(privateHost("2001:4860:4860::8888", true)).toBe(false);
  });
});

describe("safeAbs", () => {
  test("rejects non-strings, empties, and NUL-injected paths", () => {
    for (const p of [null, undefined, 123, {}, "", "\0", "a\0b"]) {
      expect(safeAbs(p as unknown)).toBeNull();
    }
  });

  test("normalizes to an absolute path", () => {
    expect(safeAbs("/a/b/../c")).toBe("/a/c");
    expect(safeAbs("relative/x")?.startsWith("/")).toBe(true);
  });
});

describe("shellSafeRel", () => {
  test("accepts plain relative paths", () => {
    for (const p of ["web", "packages/api", "a_b-c.d", "x/y/z", "svc@1"]) {
      expect(shellSafeRel(p)).toBe(true);
    }
  });

  test("rejects metacharacters, spaces, and leading dot/dash", () => {
    for (const p of ["; rm -rf ~", "a b", "$(x)", "-flag", ".hidden", "a;b", "a|b", "a`b`", "../up", "a&&b", ""]) {
      expect(shellSafeRel(p)).toBe(false);
    }
  });
});

describe("parseMakeTargets", () => {
  test("extracts targets with their ## descriptions", () => {
    const mk = "build: ## build it\n\tcc main.c\n\ntest: deps ## run tests\n\tgo test\n";
    const t = parseMakeTargets(mk);
    expect(t.find((x) => x.name === "build")?.desc).toBe("build it");
    expect(t.find((x) => x.name === "test")?.desc).toBe("run tests");
  });

  test("ignores variable assignments (:= and ::=)", () => {
    const t = parseMakeTargets("CC := gcc\nFLAGS ::= -O2\nall: build\n\techo hi\n").map((x) => x.name);
    expect(t).toContain("all");
    expect(t).not.toContain("CC");
    expect(t).not.toContain("FLAGS");
  });

  test("drops a co-target that would become a make flag (-f injection)", () => {
    const t = parseMakeTargets("all -flib/evil.mk: deps ## d\n\techo\n").map((x) => x.name);
    expect(t).toContain("all");
    expect(t).not.toContain("-flib/evil.mk");
  });

  test("skips $ and % (variable/pattern) targets", () => {
    expect(parseMakeTargets("$(OBJ): x\n\tcc\n%.o: %.c\n\tcc\n").length).toBe(0);
  });
});

describe("tokenOk", () => {
  const at = "http://localhost:4000/x";
  const reqWith = (h: Record<string, string>) => new Request(at, { headers: h });

  test("accepts a matching Bearer header", () => {
    expect(tokenOk(reqWith({ authorization: "Bearer secret" }), new URL(at), "secret")).toBe(true);
  });

  test("accepts a matching ?token= (for WS / downloads)", () => {
    expect(tokenOk(new Request(at), new URL(at + "?token=secret"), "secret")).toBe(true);
  });

  test("rejects wrong, missing, or length-mismatched tokens", () => {
    expect(tokenOk(reqWith({ authorization: "Bearer nope" }), new URL(at), "secret")).toBe(false);
    expect(tokenOk(reqWith({}), new URL(at), "secret")).toBe(false);
    expect(tokenOk(reqWith({ authorization: "Bearer s" }), new URL(at), "secret")).toBe(false);
  });
});

describe("auth exemption vs intake", () => {
  test("append-only telemetry sinks are always tokenless", () => {
    for (const p of ["/health", "/ingest", "/v1/traces", "/otlp/v1/traces", "/v1/logs", "/otlp/v1/logs"]) {
      expect(isAuthExempt(p)).toBe(true);
    }
  });

  test("/gate is the control plane — NOT auth-exempt, so a configured token guards it", () => {
    // Regression guard for the spoofed-approval-queue injection: /gate must sit
    // behind the token when one is set, not alongside the telemetry sinks.
    expect(isAuthExempt("/gate")).toBe(false);
  });

  test("/gate stays rate-limited as intake even though it authenticates", () => {
    expect(isIntake("/gate")).toBe(true);
  });

  test("reads and writes are neither exempt nor intake", () => {
    for (const p of ["/events/recent", "/gate/decide", "/workspace", "/terminal/pty"]) {
      expect(isAuthExempt(p)).toBe(false);
      expect(isIntake(p)).toBe(false);
    }
  });
});
