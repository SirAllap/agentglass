// Address classification for the origin/rebinding guards — pure and testable.
//
// The host is parsed as a real IP (not string-matched), so `10.evil.com` — a
// name anyone can register and point at 127.0.0.1 — is NOT treated as private:
// matching `/^10\./` against a hostname would turn "private network" into "any
// website", with a shell on the other end. A name is trusted only when it is
// literally localhost; everything else must *be* an address in a private range.
//
// `trustLan` gates the non-loopback private ranges. Off (the default) only
// loopback/localhost is trusted, so exposing the server to a LAN is a deliberate
// act — AGENTGLASS_TRUST_LAN=1 on top of a token — rather than something a
// browser on a colleague's machine gets for free.
import { isIP } from "node:net";

export function privateHost(hRaw: string, trustLan: boolean): boolean {
  const h = hRaw.replace(/^\[|\]$/g, ""); // a URL keeps IPv6 brackets
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 127) return true; // loopback is always local
    if (!trustLan) return false; // RFC1918 only when opted in
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (v === 6) {
    if (h === "::1") return true;
    return trustLan && /^f[cd]/i.test(h); // fc00::/7 unique-local
  }
  return false; // a name that isn't localhost resolves wherever its owner says
}
