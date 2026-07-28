/*
 * Explain is the one feature that sends your working tree off this machine.
 *
 * It takes the changed files, keeps every `+`/`-` line, and hands them to a
 * model — the local `claude` CLI or the Anthropic API, both of which leave the
 * box. That is the feature working, and it is fine for source. It was not fine
 * for the file you keep your keys in: a modified `.env` produced `+` lines like
 * any other file, and every one of them went into the prompt.
 *
 * Two rules now, and the second matters because the first cannot catch
 * everything: a credential file never has its contents sent, and the patches
 * that do go are run through the same secret scrubber the crash reporter uses,
 * for the key somebody pasted into an ordinary source file.
 *
 * Withheld files are named rather than dropped. A summary describing a
 * different changeset from the one on screen is worse than no summary, because
 * it is the one people trust.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSecretFile, trimFiles } from "../src/walkthrough.ts";
import { stripSecrets } from "../../shared/scrub.ts";

describe("files whose contents are a credential", () => {
  const SECRET = [
    ".env", ".env.local", ".env.production", ".ENV",
    "id_rsa", "id_ed25519", "id_rsa.pub",
    "deploy-key.pem", "server.key", "cert.p12", "keystore.jks", "aws.ppk",
    "credentials.json", "secrets.yaml", "secret.yml", "service-account-prod.json",
    // The shapes an extension allowlist misses, which is how the first version
    // of this rule let a terraform secrets file through.
    "secrets.tfvars.json", "credentials.enc.yaml", "secret.auto.tfvars",
    // Blunt on purpose: a file called credentials.* is withheld even when it is
    // a test. One missing file summary against a real credential is not a close
    // call — the rule's own comment says so, and this is it being applied.
    "test/credentials.test.ts",
    ".npmrc", ".netrc", ".pgpass",
    // Anywhere in the tree, not just at the root.
    "config/.env.staging", "infra/terraform/secrets.tfvars.json", "deploy/id_ed25519",
  ];
  for (const p of SECRET) {
    test(`withholds ${p}`, () => expect(isSecretFile(p)).toBe(true));
  }

  const ORDINARY = [
    "src/env.ts", "src/environment.tsx", "README.md", "package.json",
    // The near-misses that a lazy rule would swallow along with the real ones.
    "src/keyboard.ts", "docs/secrets-policy.md",
    "src/lib/keys.ts", "envoy.yaml", "src/pemberton.ts",
  ];
  for (const p of ORDINARY) {
    test(`sends ${p}`, () => expect(isSecretFile(p)).toBe(false));
  }

  test("a windows path is split on the right separator", () => {
    expect(isSecretFile("config\\\\.env")).toBe(true);
    expect(isSecretFile("src\\\\envoy.ts")).toBe(false);
  });
});

describe("the patches that do go", () => {
  test("a key pasted into ordinary source is redacted", () => {
    // No filename rule can catch this one, which is why the scrubber runs over
    // everything that survives the path filter.
    const patch = [
      "@@ -1,3 +1,4 @@",
      '+const client = new S3({ accessKeyId: "AKIAIOSFODNN7EXAMPLE" });',
      '+const gh = "ghp_" + "AbCdEf0123456789AbCdEfGh";',
    ].join("\n");
    const out = stripSecrets(patch);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_" + "AbCdEf0123456789AbCdEfGh");
    // …and the diff is still a diff. A scrubber that eats the hunk headers or
    // the paths makes the summary useless, which is why redactText (which drops
    // every path) is deliberately not what runs here.
    expect(out).toContain("@@ -1,3 +1,4 @@");
    expect(out).toContain("const client = new S3");
  });

  test("ordinary code survives intact", () => {
    const patch = '@@ -1 +1 @@\n+export const timeoutMs = 5000; // was 3000\n-import { readFileSync } from "node:fs";';
    expect(stripSecrets(patch)).toBe(patch);
  });
});

describe("what trimFiles actually hands over", () => {
  // The tests above check the two rules in isolation, which is not the same as
  // checking they are wired in — the first version of this file passed
  // unchanged against a trimFiles with both of them disabled. These call it.
  const file = (path: string, patch: string) => ({ path, tool: "git", additions: 1, deletions: 0, patch });

  // Assembled rather than written out, because a literal of this shape is a
  // live-key pattern and the repository's own secret scanner blocks the push —
  // which is the same instinct this whole file is about, applied to itself.
  const STRIPE_KEY = "sk_" + "live_51H8xQ2eZvKYlo2C";

  test("a credential file's contents never reach the prompt", () => {
    const { sent, withheld } = trimFiles([
      file(".env", `@@ -1 +1 @@\n+STRIPE_SECRET_KEY=${STRIPE_KEY}\n`),
      file("src/pay.ts", "@@ -1 +1 @@\n+export const currency = \"EUR\";\n"),
    ]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("STRIPE_SECRET_KEY");
    expect(wire).not.toContain(STRIPE_KEY);
    // The name still goes, so the summary can say a config file changed.
    expect(wire).toContain(".env");
    expect(withheld).toEqual([".env"]);
    // …and the ordinary file is untouched.
    expect(wire).toContain("export const currency");
  });

  test("a key in an ordinary file is redacted on the way out", () => {
    const { sent, withheld } = trimFiles([
      file("src/s3.ts", '@@ -1 +1 @@\n+const id = "AKIAIOSFODNN7EXAMPLE";\n'),
    ]);
    expect(JSON.stringify(sent)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // Not withheld — the file is ordinary, only the value was scrubbed.
    expect(withheld).toEqual([]);
    expect(JSON.stringify(sent)).toContain("const id");
  });

  test("nothing is withheld when nothing needs to be", () => {
    const { sent, withheld } = trimFiles([file("README.md", "@@ -1 +1 @@\n+# Title\n")]);
    expect(withheld).toEqual([]);
    expect(sent[0]!.patch).toContain("# Title");
  });
});

describe("the filter runs before either transport can see the files", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "walkthrough.ts"), "utf8");

  test("both prompt paths are handed the already-filtered list", () => {
    // The CLI and the API are two ways off this machine, not two trust levels.
    // Filtering inside one of them would leave the other open.
    expect(src).toContain("async function viaClaudeCli(sent: SentFile[])");
    expect(src).toContain("async function viaApi(sent: SentFile[])");
    // Neither transport may reach for the raw input again — only
    // generateWalkthrough calls trimFiles, exactly once, above both of them.
    const body = (name: string) => {
      const start = src.indexOf(`async function ${name}(`);
      return src.slice(start, src.indexOf("\n}\n", start));
    };
    expect(body("viaClaudeCli")).not.toContain("trimFiles");
    expect(body("viaApi")).not.toContain("trimFiles");
    // Its definition plus exactly one call site, and that call site is in
    // generateWalkthrough: two occurrences, not three.
    expect(src.split("trimFiles(").length - 1, "trimFiles gained a second call site").toBe(2);
  });

  test("withheld files are reported, not dropped", () => {
    expect(src).toContain("withheld");
    // The name still goes, so the model can say "a config file changed"; only
    // the contents stay behind.
    const trim = src.slice(src.indexOf("function trimFiles"), src.indexOf("function extractJson"));
    expect(trim).toContain("path: f.path");
    expect(trim).toContain('patch: ""');
  });

  test("SECURITY.md says Explain sends diffs off the machine", () => {
    // The storage section says everything is local, which is true of what is
    // stored and not of this. Somebody reading only that would be wrong about
    // the one feature that uploads.
    const doc = readFileSync(join(import.meta.dir, "..", "..", "SECURITY.md"), "utf8");
    expect(doc).toContain("Explain");
  });
});
