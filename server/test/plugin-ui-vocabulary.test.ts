/*
 * What a plugin may draw is a closed vocabulary checked before it is kept
 * (shared/pluginUi.ts). These are the edges of it: what fits, what is
 * refused, and that a manifest written before drawing existed keeps the
 * approval it already had.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  UI_LIMITS, coerceValue, resolveSettings, safeHref, validateContributes, validateNote, validateTree,
} from "../../shared/pluginUi.ts";
import { consentFingerprint, manifestHash, validateManifest, type PluginManifest } from "../src/plugins.ts";

describe("the tree a plugin sends", () => {
  test("a real review screen fits: split, list, timeline, tabs, form, markdown", () => {
    const tree = {
      type: "split", leftWidth: "narrow",
      left: [{ type: "list", items: [{ id: "acme/orbit#42", title: "Fix the retry", badges: [{ text: "3 high", tone: "danger" }], action: { id: "select", payload: { pr: 42 } }, selected: true }] }],
      right: [{
        type: "tabs", selected: "findings", tabs: [
          { id: "findings", label: "Findings", badge: "5", children: [{ type: "timeline", items: [{ id: "r1", at: 1, title: "Review", body: "**two** findings", tone: "warning" }] }] },
          { id: "config", label: "Run", children: [{ type: "form", id: "run", fields: [{ key: "model", type: "select", label: "Model", options: ["opus", "sonnet"] }], values: { model: "opus" }, submit: { label: "Review now", action: { id: "run" } } }] },
        ],
      }],
    };
    const r = validateTree(tree);
    expect(r.ok).toBe(true);
  });

  test("a row can point at a pull request, and the app is the one that opens it", () => {
    const r = validateTree({ type: "list", items: [
      { id: "r1", title: "Retry the webhook", open: { repo: "acme/orbit", number: 42, focus: "local" } },
      { id: "r2", title: "Idempotency keys", open: { repo: "acme/billing", number: "15" } },
    ] });
    expect(r.ok).toBe(true);
    const items = (r as { value: { items: { open?: unknown }[] } }).value.items;
    expect(items[0]!.open).toEqual({ repo: "acme/orbit", number: 42, focus: "local" });
    // A number as a string is what a plugin in a language without integers
    // sends, and it names the same pull request.
    expect(items[1]!.open).toEqual({ repo: "acme/billing", number: 15 });
  });

  test("a row that says it opens a pull request and names none is refused, not quietly dropped", () => {
    for (const open of [{ repo: "acme", number: 42 }, { repo: "acme/orbit" }, { repo: "acme/orbit", number: -1 }, "acme/orbit#42"]) {
      const r = validateTree({ type: "list", items: [{ id: "r1", title: "Row", open }] });
      expect(r.ok).toBe(false);
    }
  });

  test("a node the vocabulary does not have is refused, not skipped", () => {
    const r = validateTree({ type: "stack", children: [{ type: "html", html: "<img onerror=alert(1)>" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown node type");
  });

  test("a link is https or nothing", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://orbit.example")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("https://orbit.example/pr/42")).toBe("https://orbit.example/pr/42");
    expect(validateTree({ type: "link", text: "x", href: "javascript:alert(1)" }).ok).toBe(false);
  });

  test("too deep, too many nodes or too large a payload is refused", () => {
    let deep: Record<string, unknown> = { type: "divider" };
    for (let i = 0; i <= UI_LIMITS.depth; i++) deep = { type: "stack", children: [deep] };
    expect(validateTree(deep).ok).toBe(false);
    const wide = { type: "stack", children: Array.from({ length: UI_LIMITS.nodes + 1 }, () => ({ type: "divider" })) };
    expect(validateTree(wide).ok).toBe(false);
    const heavy = { type: "button", label: "x", action: { id: "a", payload: "y".repeat(UI_LIMITS.payloadBytes + 1) } };
    expect(validateTree(heavy).ok).toBe(false);
  });

  test("an unknown tone falls back to the default instead of carrying a colour", () => {
    const r = validateTree({ type: "badge", text: "x", tone: "#ff0000" });
    expect(r.ok && r.value).toEqual({ type: "badge", text: "x", tone: undefined });
  });
});

describe("settings", () => {
  test("values are typed by the field, whatever arrives", () => {
    expect(coerceValue({ key: "n", type: "number", label: "n", min: 1, max: 5 }, "9")).toBe(5);
    expect(coerceValue({ key: "b", type: "boolean", label: "b" }, "true")).toBeUndefined();
    expect(coerceValue({ key: "l", type: "list", label: "l" }, " a \n\nb")).toEqual(["a", "b"]);
  });

  test("every declared key is present when the plugin reads them", () => {
    const fields = [
      { key: "repos", type: "list" as const, label: "r" },
      { key: "model", type: "select" as const, label: "m", default: "opus" },
      { key: "dry", type: "boolean" as const, label: "d" },
    ];
    expect(resolveSettings(fields, { repos: ["acme/orbit"] })).toEqual({ repos: ["acme/orbit"], model: "opus", dry: false });
  });
});

describe("the manifest", () => {
  const base = { name: "orbit-lint", publisher: "acme", description: "d", entrypoint: "true", scope: "read" };

  test("a manifest with nothing beyond the basics hashes as those fields plus the default box", () => {
    // Boxes became the default, so a bare manifest no longer keeps the hash it
    // had before them: its approval is asked for again. Drawing adds nothing
    // to the hash of a manifest that does not draw.
    const m = validateManifest(base) as PluginManifest;
    const expected = createHash("sha256").update(JSON.stringify({
      name: m.name, publisher: m.publisher, description: m.description, entrypoint: m.entrypoint, scope: m.scope,
      sandbox: { network: "agentglass", read: [], write: [], programs: [] },
    })).digest("hex");
    expect(manifestHash(m)).toBe(expected);
  });

  test("declaring somewhere new to draw changes what was approved, so the person is asked again", () => {
    const plain = validateManifest(base) as PluginManifest;
    const draws = validateManifest({ ...base, contributes: { panels: [{ id: "main", title: "Lint" }] } }) as PluginManifest;
    expect(manifestHash(draws)).not.toBe(manifestHash(plain));
    // What enable actually gates on is the consent fingerprint, over the
    // files on disk; plugin.json is one of them, so the new declaration moves
    // it. Same code, different manifest bytes: a different fingerprint.
    const content = (m: PluginManifest) => createHash("sha256").update(JSON.stringify(m)).digest("hex");
    expect(consentFingerprint(draws, content(draws))).not.toBe(consentFingerprint(plain, content(plain)));
  });

  test("a panel approved as a static screen cannot start animating: `canvas` is in what was approved", () => {
    const still = validateManifest({ ...base, contributes: { panels: [{ id: "main", title: "Lint" }] } }) as PluginManifest;
    const live = validateManifest({ ...base, contributes: { panels: [{ id: "main", title: "Lint", canvas: true }] } }) as PluginManifest;
    expect(live.contributes.panels?.[0]?.canvas).toBe(true);
    expect(still.contributes.panels?.[0]?.canvas).toBeUndefined();
    expect(manifestHash(live)).not.toBe(manifestHash(still));
    expect(validateManifest({ ...base, contributes: { panels: [{ id: "main", title: "Lint", canvas: "yes" }] } })).toContain("canvas");
  });

  test("a bad contribution loses the plugin rather than being trimmed", () => {
    expect(validateManifest({ ...base, contributes: { panels: [{ id: "Main!", title: "x" }] } })).toContain("panel id");
    expect(validateContributes({ settings: [{ key: "a", type: "list", label: "a" }, { key: "a", type: "list", label: "b" }] }).ok).toBe(false);
  });
});

describe("a note", () => {
  test("anchors only to a relative path in a repository named owner/name", () => {
    const ok = validateNote({ id: "n1", repo: "acme/orbit", number: 42, severity: "high", title: "t", path: "/etc/passwd", line: 3 });
    expect(ok.ok && ok.value.path).toBeUndefined();
    expect(validateNote({ id: "n1", repo: "orbit", number: 42, severity: "high", title: "t" }).ok).toBe(false);
    expect(validateNote({ id: "n1", repo: "acme/orbit", number: 42, severity: "urgent", title: "t" }).ok).toBe(false);
  });
});

describe("the plugin's own channel", () => {
  test("is open to a plugin token at read scope, and to nothing else by that rule", async () => {
    const { allowed } = await import("../src/auth.ts");
    const plugin = { kind: "plugin" as const, scope: "read" as const, plugin: "orbit-lint" };
    expect(allowed(plugin, "POST", "/plugin/self/panel")).toBe(true);
    expect(allowed(plugin, "GET", "/plugin/self/events")).toBe(true);
    // The same token is still read-scoped everywhere else.
    expect(allowed(plugin, "POST", "/plugins/enable")).toBe(false);
    expect(allowed(plugin, "POST", "/plugin/selfish")).toBe(false);
    // A read-scope phone gets nothing from this rule, and a plugin's settings
    // and panels are not reads for it.
    const phone = { kind: "device" as const, scope: "read" as const };
    expect(allowed(phone as never, "POST", "/plugin/self/panel")).toBe(false);
    expect(allowed(phone as never, "GET", "/plugins/settings")).toBe(false);
    expect(allowed(phone as never, "GET", "/plugins/panels")).toBe(false);
  });
});

describe("a timestamp a Date cannot hold", () => {
  test("is not stored, so it cannot break the pull request it was written on", async () => {
    const { validateRun, validateTree } = await import("../../shared/pluginUi.ts");
    const r = validateRun({ id: "r1", repo: "acme/orbit", number: 42, state: "done", title: "t", startedAt: 1e16, finishedAt: -5 }, 1000);
    expect(r.ok && r.value.startedAt).toBe(1000);
    expect(r.ok && r.value.finishedAt).toBeUndefined();
    const t = validateTree({ type: "timeline", items: [{ id: "a", title: "x", at: 1e16 }] });
    expect(t.ok && (t.value as { items: { at?: number }[] }).items[0]!.at).toBeUndefined();
  });

  test("a tree over the byte budget is refused whole", async () => {
    const { validateTree, UI_LIMITS } = await import("../../shared/pluginUi.ts");
    const big = { type: "stack", children: Array.from({ length: 30 }, () => ({ type: "markdown", text: "x".repeat(39_000) })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(UI_LIMITS.treeBytes);
    expect(validateTree(big).ok).toBe(false);
  });
});

describe("a plugin's own face", () => {
  const base = { name: "orbit-lint", publisher: "acme", description: "d", entrypoint: "true", scope: "read" };
  test("an icon is a relative svg, png or webp in its folder, and a colour is hex", () => {
    expect(typeof validateManifest({ ...base, icon: "assets/icon.svg", color: "#8B5CF6" })).toBe("object");
    for (const icon of ["../icon.svg", "/etc/icon.svg", "icon.js", "a/../../icon.png", "icon.svg\n"]) {
      expect(validateManifest({ ...base, icon })).toContain("icon");
    }
    for (const color of ["red", "#fff", "#12345g", "url(x)"]) expect(validateManifest({ ...base, color })).toContain("color");
  });
});

describe("several picked from a list", () => {
  test("a multi field keeps a list of strings and takes its options at run time", () => {
    const f = { key: "repos", type: "multi" as const, label: "Repositories" };
    expect(coerceValue(f, ["acme/orbit", " acme/v2 ", "", 7])).toEqual(["acme/orbit", "acme/v2"]);
    expect(resolveSettings([f], {})).toEqual({ repos: [] });
    expect(validateContributes({ settings: [f] }).ok).toBe(true);
  });
});
