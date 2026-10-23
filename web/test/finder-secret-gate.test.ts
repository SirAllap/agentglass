/*
 * A file whose name says it holds a secret is not read by the preview until the
 * person presses Show. The name is all that is known before the file is opened.
 */
import { describe, expect, test } from "bun:test";
import { looksSecret } from "../src/lib/finderPreview.ts";

const quick = await Bun.file(new URL("../src/components/finder/machine/QuickLook.tsx", import.meta.url)).text();

describe("looksSecret", () => {
  test.each(["my_api_key", ".env", ".env.local", "id_rsa", "id_ed25519", "server.pem", "site.key", "credentials", "credentials.json", "tokens.json", "db-password.txt", "Secrets.yaml", "private_key.txt", "cert.p12", ".npmrc.token"])("%s asks", (n) => { expect(looksSecret(n)).toBe(true); });
  test.each(["notes.md", "tokenizer.py", "report.txt", ".env.example", "id_rsa.pub", "keyboard.ts", "monkey.png", "secretary.md", ".bashrc", "api.ts"])("%s does not", (n) => { expect(looksSecret(n)).toBe(false); });
});

describe("the panel", () => {
  test("says it and holds the read back until Show", () => {
    expect(quick).toContain("May hold a secret");
    expect(quick).toMatch(/row\.locked \|\| gated\) return;/);
    expect(quick).toMatch(/setShown\(path\)/);
  });
});
