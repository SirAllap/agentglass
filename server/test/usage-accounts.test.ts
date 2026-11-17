import { describe, expect, it } from "bun:test";
import {
  accountKey, accountsOf, addAccount, parseAccounts, removeAccount, resolveAccount, slugId, type UsageAccount,
} from "../../shared/usageAccounts.ts";

const SRC = ["keyring", "file", "env"];
const orbit: UsageAccount = { provider: "anthropic", id: "orbit-team", label: "Orbit team", source: "file" };

describe("usage accounts", () => {
  it("absent id keeps the bare provider key", () => {
    expect(accountKey("anthropic")).toBe("anthropic");
    expect(accountKey("anthropic", "default")).toBe("anthropic");
    expect(accountKey("anthropic", "orbit-team")).toBe("anthropic:orbit-team");
  });
  it("lists the default first even when never stored", () => {
    const l = accountsOf([orbit], "anthropic", "Claude");
    expect(l.map((a) => a.id)).toEqual(["default", "orbit-team"]);
    expect(accountsOf([orbit], "codex", "Codex").map((a) => a.id)).toEqual(["default"]);
  });
  it("a rule naming a missing account falls back to the default", () => {
    expect(resolveAccount([orbit], "anthropic", "orbit-team")).toBe("orbit-team");
    expect(resolveAccount([orbit], "anthropic", "gone")).toBe("default");
    expect(resolveAccount([orbit], "codex", "orbit-team")).toBe("default");
    expect(resolveAccount([orbit], "anthropic")).toBe("default");
  });
  it("adds with an id from the label and refuses clashes, blanks, defaults, unknown sources", () => {
    const r = addAccount([], { provider: "anthropic", label: "Orbit Team", source: "file" }, SRC);
    expect(r.ok && r.value[0]!.id).toBe("orbit-team");
    expect(addAccount([orbit], { provider: "anthropic", label: "Orbit team" }, SRC).ok).toBe(false);
    expect(addAccount([], { provider: "anthropic", label: "  " }, SRC).ok).toBe(false);
    expect(addAccount([], { provider: "anthropic", label: "Default" }, SRC).ok).toBe(false);
    expect(addAccount([], { provider: "anthropic", label: "X", source: "sk-live" }, SRC).ok).toBe(false);
    expect(addAccount([orbit], { provider: "codex", label: "Orbit team" }, SRC).ok).toBe(true);
  });
  it("caps accounts per provider", () => {
    let l: UsageAccount[] = [];
    for (let i = 0; i < 5; i++) { const r = addAccount(l, { provider: "anthropic", label: `a${i}` }, SRC); expect(r.ok).toBe(true); if (r.ok) l = r.value; }
    expect(addAccount(l, { provider: "anthropic", label: "one more" }, SRC).ok).toBe(false);
  });
  it("never removes the default", () => {
    expect(removeAccount([orbit], "anthropic", "default").ok).toBe(false);
    const r = removeAccount([orbit], "anthropic", "orbit-team");
    expect(r.ok && r.value).toEqual([]);
  });
  it("parse drops unknown fields, so a stray token is never copied", () => {
    const out = parseAccounts([{ provider: "anthropic", label: "Orbit", token: "sk-ant-x", source: "env" }, 5, { label: "x" }], SRC);
    expect(out).toEqual([{ provider: "anthropic", id: "orbit", label: "Orbit", source: "env" }]);
    expect(JSON.stringify(out)).not.toContain("sk-ant");
  });
  it("slug", () => {
    expect(slugId("  Acme / Work #2 ")).toBe("acme-work-2");
    expect(slugId("!!!")).toBe("");
  });
});
