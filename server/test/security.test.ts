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

  test("CGNAT (Tailscale) is gated by trustLan, and its edges are exact", () => {
    // A tailnet address is what Tailscale hands every node. Without this the
    // dashboard loads over Tailscale and then 403s every call inside itself,
    // which reads as a broken build rather than as a refused origin.
    for (const h of ["100.64.0.1", "100.85.155.119", "100.127.255.254"]) {
      expect(privateHost(h, false)).toBe(false);
      expect(privateHost(h, true)).toBe(true);
    }
    // 100.0.0.0/10 is not CGNAT: the range starts at 100.64 and ends at 100.127.
    for (const h of ["100.63.255.255", "100.128.0.1", "100.0.0.1", "100.255.255.255"]) {
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

  test("maps Windows drive paths onto the automount", () => {
    expect(safeAbs("C:\\Users\\Raide\\code\\app")).toBe("/mnt/c/Users/Raide/code/app");
  });

  test("clamps a translated drive path inside its own mount", () => {
    // `\` became a real separator, so `..` could climb out of the automount…
    expect(safeAbs("C:\\..\\..\\etc\\passwd")).toBeNull();
    // …or hop to a sibling drive while staying under the automount base.
    expect(safeAbs("C:\\..\\d\\thing")).toBeNull();
    // Inner `..` that stays on the drive is legitimate and keeps resolving.
    expect(safeAbs("C:\\Users\\Raide\\code\\..\\app")).toBe("/mnt/c/Users/Raide/app");
  });

  test("UNC paths are not translated: backslashes stay literal, as before", () => {
    const unc = safeAbs("\\\\server\\share\\x");
    expect(unc).not.toBeNull();
    expect(unc!.endsWith("\\\\server\\share\\x")).toBe(true);
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
  const SINKS = ["/ingest", "/v1/traces", "/otlp/v1/traces", "/v1/logs", "/otlp/v1/logs", "/agents/status"];

  test("append-only telemetry sinks are tokenless from this machine", () => {
    // A hook or an OTel exporter on this box has no way to carry a secret, and
    // hooks/send_event.py refuses any server that is not localhost — so
    // loopback is the whole of what the local senders need.
    for (const p of SINKS) expect(isAuthExempt(p, "loopback")).toBe(true);
  });

  test("and NOT from the network, because appending is not inert", () => {
    // Measured before this rule existed, on a server bound 0.0.0.0: POST
    // /ingest from a LAN address with no credential answered {"ok":true,"id":1}
    // and put a notification with a chosen title and body on the desk and on
    // the paired phone (/ingest → maybeAlert → sink.broadcast), while writing a
    // permanent row into SQLite. POST /sessions from the same address answered
    // 401, which is what the gate looks like when it is working.
    for (const p of SINKS) expect(isAuthExempt(p, "remote"), p).toBe(false);
  });

  test("/health answers to anyone: it is how a caller finds out this is us", () => {
    // The phone's pairing screen probes it before it has a credential, and the
    // desktop shell probes it to tell our sidecar from a stranger on the port.
    // It writes nothing, so there is nothing here to forge.
    expect(isAuthExempt("/health", "loopback")).toBe(true);
    expect(isAuthExempt("/health", "remote")).toBe(true);
  });

  test("the metrics refusal answers to anyone too — it stores nothing", () => {
    // Gating it would turn a silent 404 into a silent 401 for an exporter that
    // cannot carry a token: the same dead end wearing a different number.
    for (const p of ["/v1/metrics", "/otlp/v1/metrics"]) {
      expect(isAuthExempt(p, "remote"), p).toBe(true);
    }
  });

  test("/gate is the control plane — NOT auth-exempt, so a configured token guards it", () => {
    // Regression guard for the spoofed-approval-queue injection: /gate must sit
    // behind the token when one is set, not alongside the telemetry sinks.
    expect(isAuthExempt("/gate", "loopback")).toBe(false);
    expect(isAuthExempt("/gate", "remote")).toBe(false);
  });

  test("/gate stays rate-limited as intake even though it authenticates", () => {
    expect(isIntake("/gate")).toBe(true);
  });

  test("the sinks stay rate-limited whatever address they arrive from", () => {
    // Throttling is a separate question from authentication: a flood is a
    // flood, and the answer to one must not be silently taken from the other.
    for (const p of SINKS) expect(isIntake(p), p).toBe(true);
  });

  test("reads and writes are neither exempt nor intake", () => {
    for (const p of ["/events/recent", "/gate/decide", "/workspace", "/terminal/pty"]) {
      expect(isAuthExempt(p, "loopback")).toBe(false);
      expect(isAuthExempt(p, "remote")).toBe(false);
      expect(isIntake(p)).toBe(false);
    }
  });
});
