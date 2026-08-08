/*
 * The phone's half of pairing.
 *
 * The one that matters is `unseal`: it has to open what the server sealed,
 * across two entirely separate implementations of the same four steps — Node's
 * `crypto` on one side, WebCrypto on the other. Every parameter (curve, salt,
 * info string, tag placement) has to agree, and the failure when one does not
 * is a device that pairs, appears in the list, and then cannot authenticate,
 * which is a long way from here.
 *
 * So the server's real `sealTo` is imported and driven, rather than a fixture.
 * A fixture would keep passing after a change to either side.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sealTo } from "../../server/src/pairing.ts";

// api.ts reads `location` at module scope to work out which server it talks to,
// and pairing.ts imports its `SERVER`. Stubbed before the import rather than
// after, because that read happens the moment the module is evaluated.
(globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };

const { unseal, makeKeys, guessName, ticketFromUrl } = await import("../src/lib/pairing.ts");

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

describe("opening what the machine sealed", () => {
  test("the credential arrives intact", async () => {
    const k = await makeKeys();
    const token = "a-credential-that-is-not-real-0000";
    expect(await unseal(sealTo(k.pub, "ticket-id", token), k.priv, "ticket-id")).toBe(token);
  });

  test("a credential sealed to another device does not open", async () => {
    // The property that makes polling with a stolen ticket id worthless: the
    // wrap is to the key of whoever typed the code, and nobody else has it.
    const mine = await makeKeys();
    const theirs = await makeKeys();
    expect(unseal(sealTo(theirs.pub, "t", "secret"), mine.priv, "t")).rejects.toThrow();
  });

  test("the ticket is part of the derivation, not just the address", async () => {
    const k = await makeKeys();
    expect(unseal(sealTo(k.pub, "the-real-ticket", "secret"), k.priv, "another")).rejects.toThrow();
  });

  test("tampering fails loudly rather than yielding something plausible", async () => {
    // A corrupt credential stored and used later fails with an unrelated 401,
    // a long way from the thing that broke.
    const k = await makeKeys();
    const w = sealTo(k.pub, "t", "secret");
    const bytes = Buffer.from(w.data, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(unseal({ ...w, data: bytes.toString("base64url") }, k.priv, "t")).rejects.toThrow();
  });

  test("the key this device generates cannot be read out of it", async () => {
    // Non-extractable, so there is no code path anywhere — in this file or in
    // anything that imports it — that could send the private half somewhere.
    const k = await makeKeys();
    expect(k.priv.extractable).toBe(false);
    expect(crypto.subtle.exportKey("raw", k.priv)).rejects.toThrow();
  });

  test("the public half is an uncompressed P-256 point, which is what the server checks", async () => {
    const raw = Buffer.from((await makeKeys()).pub, "base64url");
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
  });
});

describe("the invitation in the address bar", () => {
  test("is read from ?pair=", () => {
    expect(ticketFromUrl("http://192.168.1.20:5959/?pair=abc123")).toBe("abc123");
    expect(ticketFromUrl("http://192.168.1.20:5959/?view=now&pair=abc123#x")).toBe("abc123");
  });

  test("and absent means there is no handshake to run", () => {
    expect(ticketFromUrl("http://192.168.1.20:5959/")).toBeNull();
    expect(ticketFromUrl("http://192.168.1.20:5959/?pair=")).toBeNull();
    expect(ticketFromUrl("http://192.168.1.20:5959/?pair=%20%20")).toBeNull();
    expect(ticketFromUrl("not a url at all")).toBeNull();
  });
});

describe("naming this device", () => {
  test("guesses something a person would recognise in a list next week", () => {
    expect(guessName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/605")).toBe("iPhone");
    expect(guessName("Mozilla/5.0 (iPad; CPU OS 17_5) Safari/605")).toBe("iPad");
    expect(guessName("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126")).toBe("Android phone");
    expect(guessName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126")).toBe("Mac");
    expect(guessName("Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/126")).toBe("Windows PC");
  });

  test("and says something rather than nothing when it cannot tell", () => {
    // The field is editable; an empty one is a device called "" in the list
    // used to decide what to cut off.
    expect(guessName("")).toBe("My device");
    expect(guessName("something nobody has seen")).toBe("My device");
  });
});

/**
 * Rules over the tree rather than about today's call sites.
 *
 * The screen exists to make two steps unmissable. A change that quietly drops
 * one of them would leave every test above passing — they are about the
 * cryptography, and the cryptography is not what makes this safe on its own.
 */
describe("the screen keeps its two steps", () => {
  const screen = read("src/PairScreen.tsx");

  test("asks for the code, and asks for it as digits", () => {
    expect(screen).toContain("inputMode=\"numeric\"");
    expect(screen).toContain("maxLength={6}");
    // The button stays dead until all six are there, so a short code cannot
    // spend one of five attempts.
    expect(screen).toContain("code.length !== 6");
  });

  test("says a person has to accept, rather than implying the code was enough", () => {
    expect(screen).toMatch(/Nothing is granted yet/);
    expect(screen).toMatch(/Waiting for someone at the computer/);
  });

  test("never writes the credential anywhere itself", () => {
    // It hands it to adoptServer (see main.tsx) and forgets it. A localStorage
    // write here would be a second copy nothing else knows how to revoke.
    expect(screen).not.toContain("localStorage");
    expect(screen).not.toContain("console.");
  });

  test("closing the pane closes the invitation", () => {
    // A QR left live because a window was shut is exactly the code somebody
    // scans off a screenshot later.
    const panel = read("src/components/PairPanel.tsx");
    expect(panel).toMatch(/useEffect\(\(\) => \(\) => \{[^}]*pairCancel/);
  });

  test("a new invitation is recorded before anything polls for it", () => {
    // Found by opening the pane: the button did nothing at all. The poll that
    // `start` fires runs before React has re-rendered, so reading the ref found
    // the *previous* value — null — asked the server about no invitation, was
    // told there is none, and cleared the one it had just minted.
    const panel = read("src/components/PairPanel.tsx");
    const start = panel.slice(panel.indexOf("const start = async"), panel.indexOf("const decide ="));
    expect(start).toContain("live.current = r.id");
    expect(start).toContain("poll(r.id)");
    expect(start.indexOf("live.current = r.id")).toBeLessThan(start.indexOf("poll(r.id)"));
  });

  test("the invitation the QR points at carries no code", () => {
    // The entire reason the QR is safe to photograph. A pairing URL that also
    // carried the digits would put this straight back where it started.
    const panel = read("src/components/PairPanel.tsx");
    const url = panel.match(/const pairUrl = [^;]+;/)?.[0] ?? "";
    expect(url).toContain("?pair=");
    expect(url).not.toContain("ticket.code");
    // …and the QR draws that, rather than anything else on the panel. Matched
    // on the prop rather than on the whole tag: the tag grew a `big` for the
    // first-run layout, and a lock that breaks on an unrelated prop teaches
    // people to edit the lock.
    expect(panel).toMatch(/<Qr\s+text=\{pairUrl\}/);
  });

  test("and the app does not mount behind it", () => {
    // This device holds no credential during the handshake, so mounting the
    // application would show an app failing to load behind a pairing form.
    const main = read("src/main.tsx");
    // The decision itself, not just the order the two branches appear in: a
    // rule about text order survives `const invitation = null`, which is
    // exactly the change that would mount the app behind the form.
    //
    // `<App />` rather than `<Root />`: there is no fork left to alias. main.tsx
    // chose between the cockpit and the browser companion, and the companion is
    // deleted — every browser gets the cockpit now, including a phone that
    // scanned this QR.
    expect(main).toContain("const invitation = ticketFromUrl(location.href);");
    expect(main).toMatch(/if \(invitation\) \{[\s\S]*<PairScreen[\s\S]*\} else \{[\s\S]*mount\(<App \/>\)/);
    expect(main).toContain("adoptServer({ token })");
  });
});
