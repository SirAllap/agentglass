/*
 * The app keeps plain http (pairing over a bare LAN or tailnet address is
 * plain http, and Android cannot scope cleartext by range), and stops trusting
 * certificate authorities the user installed.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/with-network-security.js") as { networkSecurityConfigXml(): string };
const app = JSON.parse(await Bun.file(new URL("../app.json", import.meta.url)).text());

describe("the network security config", () => {
  const xml = plugin.networkSecurityConfigXml();

  it("permits http by default, so a bare LAN or tailnet address still pairs", () => {
    expect(xml).toMatch(/<base-config cleartextTrafficPermitted="true"/);
    // No domain rule may switch it back off for the ranges the app pairs over.
    expect(xml).not.toMatch(/cleartextTrafficPermitted="false"/);
    expect(xml).not.toContain("<domain-config");
    for (const host of ["192.168.1.20", "100.64.0.5"]) expect(xml).not.toContain(host);
  });

  it("trusts the system certificate store only", () => {
    expect(xml).toMatch(/<certificates src="system"\s*\/>/);
    expect(xml).not.toContain('src="user"');
  });
});

describe("app.json", () => {
  it("does not carry the blanket manifest flag; the config file is the one place", () => {
    expect(JSON.stringify(app)).not.toMatch(/usesCleartextTraffic/);
  });

  it("wires the plugin that writes the config", () => {
    expect(app.expo.plugins).toContain("./plugins/with-network-security.js");
  });
});
