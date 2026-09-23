/*
 * robots.txt, honoured on request. The parser is held to the standard's
 * three rules — the longest user-agent match picks the group, the longest
 * path pattern picks the rule, Allow wins a tie — and the gate on `open` is
 * run against a robots.txt served by a stand-in, so what is tested is what
 * an agent meets: a refusal that names the file, the path and the switch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { __setRobotsFetch, parseRobots, robotsAllows, robotsRefusal, ROBOTS_ENV } from "../src/robots.ts";
import { askBrowser, noteBrowserReady, parseAsk, resetBrowserDrive, setBrowserSink, settleBrowser } from "../src/browserdrive.ts";

const FILE = `
# a site with opinions
User-agent: *
Disallow: /private/
Allow: /private/shared/
Disallow: /*.pdf$

User-agent: agentglass
User-agent: agentglass-browser
Disallow: /admin
Allow: /admin/help

User-agent: other
Disallow: /
`;

describe("reading a robots.txt", () => {
  test("groups are runs of user-agent lines followed by their rules", () => {
    const groups = parseRobots(FILE);
    expect(groups.map((g) => g.agents)).toEqual([["*"], ["agentglass", "agentglass-browser"], ["other"]]);
    expect(groups[1]!.rules).toEqual([{ allow: false, pattern: "/admin" }, { allow: true, pattern: "/admin/help" }]);
  });

  test("the group naming us wins over *, and inside it the longest pattern wins, Allow on a tie", () => {
    expect(robotsAllows(FILE, "/admin")).toBe(false);
    expect(robotsAllows(FILE, "/admin/users")).toBe(false);
    expect(robotsAllows(FILE, "/admin/help")).toBe(true);
    // Our group does not mention /private, and a group is the whole answer.
    expect(robotsAllows(FILE, "/private/x")).toBe(true);
    // A stranger gets the * group.
    expect(robotsAllows(FILE, "/private/x", "somebot")).toBe(false);
    expect(robotsAllows(FILE, "/private/shared/x", "somebot")).toBe(true);
    expect(robotsAllows(FILE, "/docs/report.pdf", "somebot")).toBe(false);
    expect(robotsAllows(FILE, "/docs/report.pdfx", "somebot")).toBe(true);
    // A tie between Allow and Disallow of the same length goes to Allow.
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a")).toBe(true);
  });

  test("no group for us and no *: everything is allowed; an empty or comment-only file too", () => {
    expect(robotsAllows("User-agent: other\nDisallow: /\n", "/anything")).toBe(true);
    expect(robotsAllows("", "/x")).toBe(true);
    expect(robotsAllows("# nothing here\n", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/x"), "an empty Disallow allows").toBe(true);
  });

  test("every group that names the best match is merged, and an empty User-agent names nobody", () => {
    // RFC 9309: rules for the same product token may be split across groups,
    // and all of them apply. The first version read the first `*` group only,
    // and an empty `User-agent:` matched as the best group because every
    // name starts with the empty string.
    const split = "User-agent: *\nDisallow: /a\n\nUser-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /b\n";
    expect(robotsAllows(split, "/a")).toBe(false);
    expect(robotsAllows(split, "/b"), "the second * group counts too").toBe(false);
    expect(robotsAllows(split, "/c")).toBe(true);
    const twice = "User-agent: agentglass\nDisallow: /a\n\nUser-agent: agentglass\nDisallow: /b\n";
    expect(robotsAllows(twice, "/b")).toBe(false);
    const empty = "User-agent:\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(robotsAllows(empty, "/x"), "an empty name is not our name").toBe(true);
    expect(robotsAllows("User-agent:\nDisallow: /\n", "/x"), "and alone it is no group at all").toBe(true);
  });
});

describe("the gate on open", () => {
  let served: Record<string, string> = {};
  const fetched: string[] = [];
  /** A robots.txt per host, and a 404 for the rest. Setting it again also
   *  empties the cache, which is how each test starts from nothing read. */
  const standIn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    const body = served[new URL(url).host];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
  /** Every invented name is public on paper; the real resolver would say
   *  they do not exist, and a name that does not resolve is not fetched. */
  const publicName = async () => [{ address: "203.0.113.9", family: 4 }];
  beforeAll(() => __setRobotsFetch(standIn, publicName));
  afterAll(() => { __setRobotsFetch(null); delete process.env[ROBOTS_ENV]; });
  afterEach(() => { delete process.env[ROBOTS_ENV]; resetBrowserDrive(); });

  test("a disallowed path is refused by name, an allowed one and a missing file are not", async () => {
    served = { "orbit.example": "User-agent: *\nDisallow: /internal/\n" };
    __setRobotsFetch(standIn, publicName);
    const why = await robotsRefusal("https://orbit.example/internal/report?x=1");
    expect(why).not.toBeNull();
    expect(why).toContain("https://orbit.example/robots.txt");
    expect(why).toContain("/internal/report?x=1");
    expect(why).toContain(ROBOTS_ENV);
    expect(await robotsRefusal("https://orbit.example/public")).toBeNull();
    expect(await robotsRefusal("https://nofile.example/internal/x"), "no robots.txt is no rule").toBeNull();
    expect(await robotsRefusal("not a url")).toBeNull();
  });

  test("the fetch is held to the browser's own policy on every hop: link-local by redirect or by name is never reached", async () => {
    /* The first version turned the host check off entirely (a no-op
       hostCheck), so with the switch on, an `open` of https://evil.example/x
       made the SERVER — not the browser, so the egress guard never saw it —
       GET evil.example/robots.txt, follow its 302 to 169.254.169.254, and
       leak allow/refuse as one bit of the body. Loopback and the LAN stay
       fetchable, as they are for the browser; link-local and the unspecified
       address are not, on the literal and on what a name resolves to. */
    fetched.length = 0;
    served = { "orbit.example": "User-agent: *\nDisallow: /\n" };
    const redirecting = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url.startsWith("https://hop.example/")) return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      if (url.startsWith("http://169.254.")) return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      return standIn(input);
    }) as typeof fetch;
    __setRobotsFetch(redirecting, async (host) => (host === "meta.example" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "203.0.113.9", family: 4 }]));
    expect(await robotsRefusal("https://hop.example/anything"), "a redirect to link-local is not followed, and the verdict is allow").toBeNull();
    expect(fetched.some((u) => u.includes("169.254")), "the second hop was never made").toBe(false);
    expect(await robotsRefusal("https://meta.example/anything"), "a name that resolves link-local is not fetched").toBeNull();
    expect(fetched.some((u) => u.startsWith("https://meta.example/"))).toBe(false);
    expect(await robotsRefusal("http://169.254.169.254/anything")).toBeNull();
    expect(fetched.some((u) => u.startsWith("http://169.254."))).toBe(false);
    // Loopback is where a dev server lives, and its robots.txt is fetched.
    served = { "127.0.0.1:9": "User-agent: *\nDisallow: /\n", "orbit.example": "User-agent: *\nDisallow: /\n" };
    __setRobotsFetch(redirecting, publicName);
    expect(await robotsRefusal("http://127.0.0.1:9/x")).not.toBeNull();
    expect(await robotsRefusal("https://orbit.example/x"), "a public name still resolves and is fetched").not.toBeNull();
    __setRobotsFetch(standIn, publicName);
  });

  test("one fetch per origin: the file is cached", async () => {
    fetched.length = 0;
    await robotsRefusal("https://orbit.example/a");
    await robotsRefusal("https://orbit.example/b");
    await robotsRefusal("https://orbit.example/internal/c");
    expect(fetched.filter((u) => u.startsWith("https://orbit.example/")).length).toBeLessThanOrEqual(1);
  });

  test("with the switch on, `open` is refused before it reaches the window; off, it goes through", async () => {
    served = { "orbit.example": "User-agent: agentglass\nDisallow: /internal/\n" };
    __setRobotsFetch(standIn, publicName);
    const reached: string[] = [];
    setBrowserSink({ send: (ask) => { reached.push(ask.op); settleBrowser(ask.id, { ok: true, value: { url: "https://orbit.example/internal/x", title: "t" } }); }, listeners: () => 1 });
    noteBrowserReady("w-robots", true);
    const parsed = parseAsk("open", { url: "https://orbit.example/internal/x" });
    if (!("ask" in parsed)) throw new Error(parsed.error);

    process.env[ROBOTS_ENV] = "1";
    const refused = await askBrowser(parsed.ask);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("robots.txt disallows /internal/x");
    expect(reached).toEqual([]);

    const allowed = parseAsk("open", { url: "https://orbit.example/public" });
    if (!("ask" in allowed)) throw new Error(allowed.error);
    expect((await askBrowser(allowed.ask)).ok).toBe(true);
    expect(reached).toEqual(["open"]);

    delete process.env[ROBOTS_ENV];
    const off = parseAsk("open", { url: "https://orbit.example/internal/x" });
    if (!("ask" in off)) throw new Error(off.error);
    expect((await askBrowser(off.ask)).ok).toBe(true);
    expect(reached).toEqual(["open", "open"]);
  });
});
