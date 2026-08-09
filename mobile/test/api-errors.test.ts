/*
 * What a failed request is allowed to put on a phone's screen.
 *
 * Found in QA, not in review, and worth the file: with the sidecar down the
 * Home screen's Plan card rendered
 *
 *   fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:4000
 *
 * verbatim, twice — once in the card and once in the status line above it. Two
 * things wrong with that and only one of them is about tidiness.
 *
 * The other is that the address in a connection error is the USER'S OWN
 * NETWORK. A phone pairs over the LAN or a tailnet, so a screenshot of a
 * disconnected Home screen publishes where the machine lives. Nothing that
 * reaches a caller may carry one.
 *
 * `Network request failed` — React Native's own wording — was the only shape
 * handled. Hermes on Android hands the JVM exception through instead, and there
 * are several of those.
 */
import { describe, expect, test } from "bun:test";
import { describeFailure } from "../src/lib/api.ts";

const err = (message: string, name = "Error"): Error => {
  const e = new Error(message);
  e.name = name;
  return e;
};

describe("a machine that is not there says so in words", () => {
  test("the exact string QA captured", () => {
    expect(describeFailure(err(
      "fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:4000",
    ))).toBe("Cannot reach the computer");
  });

  test("the other shapes Android and React Native produce", () => {
    for (const message of [
      "Network request failed",
      "java.net.UnknownHostException: Unable to resolve host \"machine.local\"",
      "java.net.SocketTimeoutException: failed to connect to /192.168.1.20 (port 4000)",
      "java.net.NoRouteToHostException: No route to host",
      "connect ECONNREFUSED 127.0.0.1:4000",
      "connect EHOSTUNREACH 192.168.1.20:4000",
    ]) {
      expect(describeFailure(err(message)), message).toBe("Cannot reach the computer");
    }
  });

  test("a timeout is its own sentence, because it is a different fact", () => {
    // The machine answered nothing in fifteen seconds, which is not the same as
    // not being there — and the thing to do about it is different too.
    expect(describeFailure(err("Aborted", "AbortError"))).toBe("The computer did not answer in time");
  });
});

describe("and nothing that gets through carries an address", () => {
  /** Every spelling this app can actually produce one in. */
  const addressed: [string, string][] = [
    ["Something odd at 192.168.1.20:4000", "Something odd at the computer"],
    ["Something odd at /127.0.0.1:4000", "Something odd at the computer"],
    ["Something odd at localhost:4000", "Something odd at the computer"],
    ["Something odd at [::1]:4000", "Something odd at the computer"],
    ["Something odd at serallap.tail24eb8d.ts.net", "Something odd at the computer"],
    ["Something odd at machine.local", "Something odd at the computer"],
  ];

  for (const [raw, want] of addressed) {
    test(raw, () => expect(describeFailure(err(raw))).toBe(want));
  }

  test("an unrecognised failure keeps its words", () => {
    // The scrub must not turn every surprise into a shrug: a message this code
    // did not anticipate is the one somebody most needs to read.
    expect(describeFailure(err("The computer answered 500")))
      .toBe("The computer answered 500");
    expect(describeFailure("a string, not an Error")).toBe("a string, not an Error");
  });

  test("and it does not eat filenames on the way past", () => {
    /*
     * The first spelling of the scrub was "anything with a dot in it", which
     * took `index.tsx` and `shared/types.ts` out of messages that named them —
     * turning a failure somebody could act on into a vague one. A bare dotted
     * name is only an address when it carries a port.
     */
    expect(describeFailure(err("could not parse shared/types.ts")))
      .toBe("could not parse shared/types.ts");
    expect(describeFailure(err("index.tsx is not valid JSON")))
      .toBe("index.tsx is not valid JSON");
  });
});
