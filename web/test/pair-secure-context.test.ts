/*
 * Why a phone could not pair, and why it could not find out.
 *
 * Reported from a real phone: the QR opened `http://100.64.0.1:4000/?pair=…`,
 * the form appeared, "Ask to connect" did nothing — on the phone or on the
 * desktop — and the only feedback was "Still preparing the connection — try
 * again in a second."
 *
 * The cause is a browser rule, not a bug in the handshake: `crypto.subtle`
 * exists only in a *secure context*, which is HTTPS or localhost and nothing
 * else. Over plain HTTP there is no WebCrypto, so the ECDH keypair the pairing
 * is built on cannot be generated at all.
 *
 * What made it a mystery rather than a message is the second half, and it is
 * the part worth guarding: key generation rejected immediately and set the
 * screen to `failed`, then the `/pair/info` fetch resolved a network
 * round-trip later and put the form back over it. The accurate diagnosis was
 * replaced by an invitation to keep tapping.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// api.ts reads `location` at module scope and pairing.ts imports its `SERVER`.
// Stubbed before the import, because that read happens on evaluation.
(globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
const { pairingBlocked } = await import("../src/lib/pairing.ts");

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("whether this page can pair at all", () => {
  test("a secure context can, and is not warned about anything", () => {
    expect(pairingBlocked({ subtle: {}, origin: "https://box.tail1234.ts.net", isSecureContext: true })).toBeNull();
    // localhost is a secure context too, which is why this never showed up in
    // development or in any headless run.
    expect(pairingBlocked({ subtle: {}, origin: "http://localhost:4000", isSecureContext: true })).toBeNull();
  });

  test("and one without WebCrypto is told what is wrong, not that it should retry", () => {
    const why = pairingBlocked({ subtle: undefined, origin: "http://192.168.1.9:4000", isSecureContext: false });
    expect(why).toBeTruthy();
    // The cause, in terms somebody can check.
    expect(why!).toMatch(/secure context/i);
    expect(why!).toContain("http://192.168.1.9:4000");
    // …and never the word that sent them round the loop.
    expect(why!, "the message still suggests trying again").not.toMatch(/try again/i);
  });

  test("a tailnet address gets the advice that actually applies to it", () => {
    /*
     * The reported case. 100.64.0.0/10 is what Tailscale hands out, and it is
     * the route this app *recommends* — so telling somebody there to "use
     * HTTPS" without saying how is telling them to abandon the thing they
     * already set up. `tailscale serve` puts Tailscale's HTTPS in front of the
     * app on the MagicDNS name — an actual secure context — which is the
     * concrete step, unlike `tailscale cert` alone (which only fetches files).
     */
    const why = pairingBlocked({ subtle: undefined, origin: "http://100.64.0.1:4000", isSecureContext: false })!;
    expect(why).toContain("tailscale serve");
    expect(why).toMatch(/HTTPS/i);
  });

  test("and a plain LAN address gets the other one", () => {
    const why = pairingBlocked({ subtle: undefined, origin: "http://192.168.1.9:4000", isSecureContext: false })!;
    expect(why).not.toContain("tailscale serve");
    expect(why).toMatch(/localhost/);
  });

  test("100.x that is not in the tailnet range is not called Tailscale", () => {
    // 100.128.0.0 is ordinary public space. Telling somebody to run
    // `tailscale serve` for it sends them somewhere that cannot help.
    const why = pairingBlocked({ subtle: undefined, origin: "http://100.128.0.5:4000", isSecureContext: false })!;
    expect(why).not.toContain("tailscale serve");
  });
});

describe("the screen that reported it", () => {
  const screen = src("../src/PairScreen.tsx");

  test("asks before it tries, because a retry cannot change the answer", () => {
    expect(screen).toContain("pairingBlocked()");
  });

  test("and nothing finished can be overwritten by something slower", () => {
    /*
     * The race that turned a correct diagnosis into a useless one. Two effects
     * run on mount — key generation and the ticket fetch — and only one of them
     * involves the network. Any `setStage` that is not guarded is a chance for
     * the slower one to bury the faster one's verdict.
     */
    expect(screen).toContain("TERMINAL.includes(cur)");
    // Every stage set from an async continuation goes through the guard. A
    // bare `setStage` in a `.then` is exactly what caused this.
    const async = screen.split("\n").filter((l) => /\.then\(|\.catch\(/.test(l) && /setStage\(/.test(l));
    expect(async, `an async path sets the stage directly:\n${async.join("\n")}`).toEqual([]);
  });
});

describe("the screen that chose the address", () => {
  const panel = src("../src/components/PairPanel.tsx");

  test("says so before somebody walks over with a phone", () => {
    // The phone is the wrong place to learn this: by then they have scanned,
    // typed a name and read six digits off a screen.
    //
    // Whose limitation it is has to be in the sentence. This asserted the
    // opening words "A phone cannot pair over this address" until there was an
    // app, which generates its own key and pairs over exactly this address —
    // at which point the warning sat above the QR talking people out of the
    // one route that would have worked for them.
    expect(panel).toMatch(/in a browser cannot pair over this address/);
    expect(panel).not.toMatch(/A phone cannot pair over this address/);
    expect(panel).toContain("const insecure =");
  });

  test("and only for addresses where it is true", () => {
    // A rule over the expression rather than over a rendered string, because
    // this has to keep being right for https and for loopback.
    const m = /const insecure = (.+);/.exec(panel)!;
    const insecure = (url: string) => eval(m[1]!.replace(/baseUrl/g, JSON.stringify(url)));
    expect(insecure("http://100.64.0.1:4000")).toBe(true);
    expect(insecure("http://192.168.1.9:4000")).toBe(true);
    expect(insecure("https://box.tail1234.ts.net")).toBe(false);
    expect(insecure("http://localhost:4000")).toBe(false);
    expect(insecure("http://127.0.0.1:4000")).toBe(false);
  });
});

describe("what the app claims about pairing over plain HTTP", () => {
  const pane = src("../src/components/RemoteAccessPane.tsx");
  const pair = src("../src/components/PairPanel.tsx");

  test("no longer promises an encryption the browser will not allow", () => {
    /*
     * The pane used to say the credential "is encrypted to the device that
     * asked for it" on exactly the route where the browser withholds the
     * primitives to do that. A security claim that is false is worse than a
     * missing one: it is the sentence somebody reads to decide the risk is
     * handled.
     *
     * Asserted across BOTH files, which is stricter than before: the claim used
     * to be checked only where it happened to be written, so moving it would
     * have moved it out from under its own guard.
     */
    for (const [name, text] of [["RemoteAccessPane", pane], ["PairPanel", pair]] as const) {
      expect(text, `the false claim is back in ${name}`).not.toMatch(/encrypted to the device that asked for it/);
    }
  });

  test("and says plainly, once, that it is the BROWSER that cannot pair", () => {
    /*
     * Two corrections to one sentence, made on two branches, and both are kept
     * here because they answer different questions.
     *
     * WHERE it is said: once, next to the button it disables. It lives in
     * PairPanel because that is where the recipe for fixing it is —
     * RemoteAccessPane said the same thing eleven lines above in different
     * words, and two red boxes making one claim read as two problems.
     *
     * WHOSE limitation it is: the browser's, not the phone's. "a phone cannot
     * pair over it at all" was honest while the companion was a page. It is
     * false now — the app makes its own key — and it did real damage: the pane
     * hid the LAN addresses behind it and pushed a tailnet address that fails
     * with "nothing answered" whenever the phone is signed out of the tailnet.
     *
     * So the assertion is not that the warning is gone. It is that the warning
     * is in one place and names the browser there. Dropping it would take a
     * true and useful thing off the screen.
     *
     * WHAT the browser is running: the cockpit. This asked for `/browser
     * cannot/`, and "the companion in a browser cannot" — the sentence that
     * was still on the other branch of this merge — satisfies it word for
     * word. The companion was deleted in 86b07f7; a guard that accepts a name
     * for a page that no longer exists is not guarding the thing that goes
     * wrong here, which is somebody reading these two files to decide what a
     * QR should grant. So it pins the phrase PairPanel actually shows.
     */
    expect(pair).toMatch(/cannot pair over this address/);
    expect(pair, "the limitation must name the browser, not the phone")
      .toMatch(/cockpit in a browser cannot pair over this address/);
    expect(pair, "the deleted companion is back in the sentence").not.toMatch(/companion in a browser/);
    expect(pane, "the deleted companion is back in the sentence").not.toMatch(/companion in a browser/);
    expect(pair, "the claim is true of a browser, not of a phone").not.toMatch(/cannot pair over it at all/);
    expect(pane, "said twice again").not.toMatch(/cannot pair over/);
  });
});
