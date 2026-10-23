/*
 * The setting that decides which repositories a review plugin may read the
 * authoring session of: `plugins.sessionReads.repos`.
 *
 * Off is the default and the failure mode. Nothing is shared until a person
 * adds a repository, a list that could not be read is empty, a save the
 * server refused puts the old list back, and an agent can read the list but
 * never widen it: what a plugin may see of the owner's work is the owner's.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal.ts";
import { NEEDS_APPROVAL } from "../../shared/settingClass.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

/** What the server holds, and what it is told. */
const server = { repos: [] as string[], known: ["acme/orbit", "acme/helm"], posts: [] as unknown[], refuse: false, down: false };
stubGlobal("fetch", (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (!url.includes("/plugins/session-reads")) return new Response("{}", { status: 404 });
  if (server.down) throw new Error("offline");
  if (init?.method === "POST") {
    const body = JSON.parse(init.body ?? "{}") as { repos: string[] };
    server.posts.push(body.repos);
    if (server.refuse) return Response.json({ ok: false }, { status: 403 });
    server.repos = body.repos;
    return Response.json({ ok: true, repos: server.repos });
  }
  return Response.json({ ok: true, repos: server.repos, known: server.known });
}) as unknown as typeof fetch);

const R = await import("../src/lib/settingsRegistry.ts");
const reads = await import("../src/lib/sessionReads.ts");

const ID = "plugins.sessionReads.repos";
const def = () => R.SETTING_DEFS.find((d) => d.id === ID)!;
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { reads.__forgetSessionReads(); Object.assign(server, { repos: [], posts: [], refuse: false, down: false }); });
afterAll(() => { reads.__forgetSessionReads(); });

describe("the def", () => {
  it("exists on the Review prompts page, in its own section, off by default", () => {
    expect(def().page).toBe("review-prompts");
    expect(def().section).toBe("Review sessions");
    expect(def().default).toBe("");
    expect(def().type).toBe("string");
    expect(def().secret).toBeUndefined();
  });

  /* An escalation (shared/settingClass.ts): more repositories wait for the
     person (the window answers NEEDS_APPROVAL and the server makes a request),
     fewer apply at once, and a change the server granted applies. */
  it("an agent widening it is answered NEEDS_APPROVAL and nothing is sent", async () => {
    const s = R.makeSettings(R.SETTING_DEFS);
    server.repos = ["acme/orbit"];
    await reads.loadSessionReads();
    expect(s.get(ID)).toMatchObject({ ok: true, id: ID, value: "acme/orbit" });
    const wrote = s.set(ID, "acme/orbit,acme/helm");
    expect(wrote).toEqual({ ok: false, error: NEEDS_APPROVAL });
    expect(server.posts).toEqual([]);
    expect(s.list().find((x) => x.id === ID)).toMatchObject({ writable: true, class: "escalation" });
  });

  it("an agent narrowing it applies at once, and a granted widening applies", async () => {
    const s = R.makeSettings(R.SETTING_DEFS);
    server.repos = ["acme/orbit", "acme/helm"];
    await reads.loadSessionReads();
    expect(s.set(ID, "acme/orbit")).toMatchObject({ ok: true, prev: "acme/orbit,acme/helm", value: "acme/orbit" });
    expect(s.set(ID, "acme/orbit,acme/wiki", "chair", true)).toMatchObject({ ok: true, value: "acme/orbit,acme/wiki" });
  });

  it("it is on the one page that stays otherwise unmigrated, not on the left-out ones", () => {
    expect(Object.keys(R.NOT_EXPOSED_ON_PURPOSE)).not.toContain(def().page);
    expect(R.MIGRATED["review-prompts"]).toEqual(["Review sessions"]);
    expect((R.NOT_YET_MIGRATED as readonly string[]).includes("review-prompts")).toBe(false);
  });

  it("says in words what none means", () => {
    expect(def().display("")).toContain("nothing is shared");
    expect(def().display("acme/orbit,acme/helm")).toBe("acme/orbit, acme/helm");
  });

  it("takes owner/name pairs, lower-cased and unique, and nothing else", () => {
    expect(def().validate("Acme/Orbit, acme/orbit,acme/helm")).toBe("acme/orbit,acme/helm");
    expect(def().validate("")).toBe("");
    for (const bad of ["orbit", "acme/orbit/extra", "acme orbit/x", 4, true, null, Array.from({ length: 201 }, (_, i) => `a/r${i}`).join(",")]) {
      expect(def().validate(bad), String(bad)).toBeNull();
    }
  });
});

describe("what the window holds", () => {
  it("nothing is allowed until the server says so, and asking costs one read", async () => {
    expect(reads.sessionReadReposNow()).toEqual([]);
    expect(reads.sessionReadReposNow()).toEqual([]);
    await settle();
    expect(reads.sessionReadReposNow()).toEqual([]);
    server.repos = ["acme/orbit"];
    reads.__forgetSessionReads();
    reads.sessionReadReposNow();
    await settle();
    expect(reads.sessionReadReposNow()).toEqual(["acme/orbit"]);
  });

  it("a read that failed leaves it empty, never wider", async () => {
    server.down = true;
    server.repos = ["acme/orbit"];
    expect(await reads.loadSessionReads()).toBeNull();
    expect(reads.sessionReadReposNow()).toEqual([]);
  });

  it("adding a repository changes the held list at once and saves the cleaned list", async () => {
    await reads.loadSessionReads();
    def().set("Acme/Orbit");
    expect(reads.sessionReadReposNow()).toEqual(["acme/orbit"]);
    await settle();
    expect(server.posts).toEqual([["acme/orbit"]]);
  });

  it("turning one off removes it", async () => {
    server.repos = ["acme/orbit", "acme/helm"];
    await reads.loadSessionReads();
    def().set("acme/helm");
    await settle();
    expect(server.repos).toEqual(["acme/helm"]);
  });

  it("a save the server refused puts the old list back", async () => {
    server.repos = ["acme/orbit"];
    await reads.loadSessionReads();
    server.refuse = true;
    def().set("acme/orbit,acme/helm");
    expect(reads.sessionReadReposNow()).toEqual(["acme/orbit", "acme/helm"]);
    await settle();
    expect(reads.sessionReadReposNow()).toEqual(["acme/orbit"]);
  });

  it("cleanRepos drops what the server would", () => {
    expect(reads.cleanRepos(["Acme/Orbit", "acme/orbit", "bad", " acme/helm "])).toEqual(["acme/orbit", "acme/helm"]);
  });
});

describe("the page", () => {
  const pane = readFileSync(new URL("../src/components/ReviewPromptsPane.tsx", import.meta.url), "utf8");
  const code = pane.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

  it("has the section, the row bound to the def, and says what is shared and that a secret blocks it", () => {
    expect(pane).toContain('title="Review sessions"');
    expect(pane).toContain('settingId="plugins.sessionReads.repos"');
    expect(pane).toContain("Let review plugins read the authoring session");
    expect(pane).toContain("looks like a secret, nothing is shared");
    expect(pane).toContain("Never the transcript or any tool output");
  });

  it("changes it through the def, with the house select and switch, one toggle per allowed repository", () => {
    expect(code).toContain('setting("plugins.sessionReads.repos").set(');
    expect(code).toContain("style={SELECT_BOX}");
    expect(code).toMatch(/allowed\.map\(\(r\) => \(\s*<Toggle key=\{r\} on /);
    expect(code).not.toMatch(/localStorage/);
  });

  it("offers the repositories the app already knows, not the ones already allowed", () => {
    expect(code).toContain("(reads?.known ?? []).filter((r) => !allowed.includes(r))");
  });
});
