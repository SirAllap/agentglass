/*
 * The app's network security config: cleartext stays allowed, user-installed
 * certificate authorities do not.
 *
 * Cleartext stays allowed because pairing over a bare LAN or tailnet address
 * (`http://192.168.1.20:4000`, `http://100.64.0.5:4000`) is plain http, and the
 * pairing token is the protection, not the transport. Android's config matches
 * names and single addresses, never ranges, so the only choices are "every host"
 * or "a list of names"; a list of names would refuse the app's main path.
 * Narrowing to localhost and `*.ts.net` was tried and dropped for that reason.
 *
 * What the file adds over the manifest flag it replaces: https is verified
 * against the system store only, so a certificate authority the person (or
 * malware) installed on the phone cannot vouch for a host.
 *
 * A config plugin because `android/` is generated and gitignored (see
 * with-release-signing.js): the file has to be written inside prebuild.
 */
const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function networkSecurityConfigXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;
}

function withNetworkSecurity(config) {
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    delete app.$["android:usesCleartextTraffic"];
    return cfg;
  });
  return withDangerousMod(config, ["android", (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "network_security_config.xml"), networkSecurityConfigXml());
    return cfg;
  }]);
}

module.exports = withNetworkSecurity;
module.exports.networkSecurityConfigXml = networkSecurityConfigXml;
