/*
 * A file from the Finder in a tab of the agentglass browser.
 *
 * Two things are pinned: the page runs no script unless asked, and even then
 * stays in an opaque sandbox with no network; and its address carries a ticket
 * for that one file as it is now, for ten minutes — never the token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageByTicket, pageFacts, pageResponse } from "../src/browse.ts";
import { PAGE_TICKET_MS, PAGE_TICKET_STALE, pageTicket, pageTicketDoor, pageTicketPathRefusal, pageTicketRefusal } from "../src/auth.ts";

const was = { cfg: process.env.XDG_CONFIG_HOME, state: process.env.AGENTGLASS_STATE_DIR, roots: process.env.AGENTGLASS_DISK_ROOTS };
const root = mkdtempSync(join(tmpdir(), "agx-pageticket-"));
const docs = join(root, "docs");
const page = join(docs, "mockup.html");

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = join(root, "cfg");
  process.env.AGENTGLASS_STATE_DIR = join(root, "state");
  process.env.AGENTGLASS_DISK_ROOTS = docs;
  mkdirSync(docs, { recursive: true });
  writeFileSync(page, "<!doctype html><button onclick=\"document.body.dataset.s='b'\">B</button>");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["XDG_CONFIG_HOME", was.cfg], ["AGENTGLASS_STATE_DIR", was.state], ["AGENTGLASS_DISK_ROOTS", was.roots]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("/preview/page", () => {
  test("an html file is a page with no scripts by default", async () => {
    const r = await pageResponse(page, true);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox;/);
    expect(csp.includes("allow-scripts")).toBe(false);
    expect(csp.includes("script-src")).toBe(false);
    expect(csp).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toContain("<button");
  });

  test("its scripts run only when asked, still in an opaque sandbox", async () => {
    const csp = (await pageResponse(page, true, {}, true)).headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp.includes("allow-same-origin")).toBe(false);
    expect(csp).toContain("default-src 'none'");
  });

  test("a path the Finder may not read is refused with a sentence", async () => {
    const r = await pageResponse("/etc/passwd", false);
    expect(r.status).toBe(404);
    const body = await r.json() as { error: string };
    expect(body.error.length).toBeGreaterThan(10);
    expect(body.error).toMatch(/ /);
  });
});

describe("the page ticket", () => {
  const now = 1_800_000_000_000;
  test("opens the file it was signed for and nothing else", () => {
    const f = pageFacts(page)!;
    const t = pageTicket("machine-token", f, false, now);
    expect(t.includes("machine-token")).toBe(false);
    expect(pageTicketRefusal("machine-token", f, t, false, now)).toBeNull();
    expect(pageTicketRefusal("machine-token", { ...f, real: join(docs, "other.html") }, t, false, now)).toMatch(/no longer fits/);
    expect(pageTicketRefusal("another-token", f, t, false, now)).toMatch(/no longer fits/);
    expect(pageTicketRefusal("machine-token", f, "", false, now)).toMatch(/not valid/);
    expect(pageTicketRefusal("", f, t, false, now)).toMatch(/not valid/);
    // No such file and another file: the same sentence, so neither is told apart.
    expect(pageTicketRefusal("machine-token", null, t, false, now)).toBe(PAGE_TICKET_STALE);
    expect(pageTicketRefusal("machine-token", { ...f, ino: f.ino + 1 }, t, false, now)).toBe(PAGE_TICKET_STALE);
  });

  test("the path half is checked from the words alone, before anything is opened", () => {
    const f = pageFacts(page)!;
    const t = pageTicket("machine-token", f, false, now);
    expect(pageTicketPathRefusal("machine-token", f.real, t, false, now)).toBeNull();
    expect(pageTicketPathRefusal("machine-token", join(docs, "other.html"), t, false, now)).toMatch(/not valid/);
    expect(pageTicketPathRefusal("another-token", f.real, t, false, now)).toMatch(/not valid/);
    expect(pageTicketPathRefusal("machine-token", f.real, t, true, now)).toMatch(/not valid/);
    expect(pageTicketPathRefusal("machine-token", f.real, t, false, now + PAGE_TICKET_MS)).toMatch(/expired/);
    // The old two-part ticket is not a ticket any more.
    expect(pageTicketPathRefusal("machine-token", f.real, t.split(".").slice(0, 2).join("."), false, now)).toMatch(/not valid/);
  });

  test("the scripts switch is signed: a no-scripts ticket does not open with scripts", () => {
    const f = pageFacts(page)!;
    expect(pageTicketRefusal("machine-token", f, pageTicket("machine-token", f, false, now), true, now)).toMatch(/no longer fits/);
  });

  test("a changed file no longer fits", () => {
    const f = pageFacts(page)!;
    const t = pageTicket("machine-token", f, false, now);
    expect(pageTicketRefusal("machine-token", { ...f, size: f.size + 1 }, t, false, now)).toMatch(/changed/);
    expect(pageTicketRefusal("machine-token", { ...f, mtimeMs: f.mtimeMs + 1000 }, t, false, now)).toMatch(/changed/);
  });

  test("it expires after ten minutes", () => {
    const f = pageFacts(page)!;
    const t = pageTicket("machine-token", f, false, now);
    expect(pageTicketRefusal("machine-token", f, t, false, now + PAGE_TICKET_MS - 1)).toBeNull();
    expect(pageTicketRefusal("machine-token", f, t, false, now + PAGE_TICKET_MS)).toMatch(/expired/);
  });

  test("the gate takes a ticket only for a GET of the page route, from this machine, with a token", () => {
    expect(pageTicketDoor("tok", "GET", "/preview/page", "loopback", "t")).toBe("check");
    expect(pageTicketDoor("tok", "GET", "/preview/page", "remote", "t")).toBe("skip");
    expect(pageTicketDoor("tok", "POST", "/preview/page", "loopback", "t")).toBe("skip");
    expect(pageTicketDoor("tok", "GET", "/preview/raw", "loopback", "t")).toBe("skip");
    expect(pageTicketDoor(null, "GET", "/preview/page", "loopback", "t")).toBe("skip");
    expect(pageTicketDoor("tok", "GET", "/preview/page", "loopback", null)).toBe("skip");
  });
});

describe("a ticket is checked against the open file, which is the one read", () => {
  const tok = "machine-token";
  const serve = (path: string, t: string, held = false) =>
    pageByTicket(path, () => pageTicketPathRefusal(tok, path, t, false), (f) => pageTicketRefusal(tok, f, t, false), () => held);

  test("a fitting ticket serves the file from its handle", async () => {
    const r = await serve(page, pageTicket(tok, pageFacts(page)!, false));
    expect(r).toBeInstanceOf(Response);
    expect(await (r as Response).text()).toContain("<button");
    expect((r as Response).headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  test("another file renamed into its place, same size and mtime (a hardlink), does not fit", async () => {
    const mock = join(docs, "mock.html");
    const secret = join(root, "secret");
    // Assembled at runtime so a secret scanner on the public repo does not flag it.
    writeFileSync(secret, ["PRIVATE", "KEY-0123456789"].join("-"));
    writeFileSync(mock, "x".repeat(statSync(secret).size));
    const f = pageFacts(mock)!;
    const t = pageTicket(tok, f, false);
    mkdirSync(join(docs, "tmp"), { recursive: true });
    const swap = join(docs, "tmp", "mock.html");
    linkSync(secret, swap);
    utimesSync(swap, new Date(f.mtimeMs), new Date(f.mtimeMs));
    renameSync(swap, mock);
    const g = pageFacts(mock)!;
    expect(g.size).toBe(f.size);
    expect(Math.floor(g.mtimeMs)).toBe(Math.floor(f.mtimeMs));
    const r = await serve(mock, t);
    expect(r).not.toBeInstanceOf(Response);
    expect(r).toMatchObject({ status: 401 });
    expect((r as { error: string }).error).toMatch(/no longer fits/);
  });

  test("a path that became a link after the ticket was made is refused", async () => {
    const link = join(docs, "link.html");
    writeFileSync(link, "was a file");
    const t = pageTicket(tok, pageFacts(link)!, false);
    rmSync(link);
    symlinkSync(page, link);
    expect(pageFacts(link)).toBeNull();
    const r = await serve(link, t);
    expect(r).toMatchObject({ status: 401 });
    expect((r as { error: string }).error).toMatch(/no longer fits/);
  });

  test("held back judges where the open file is, and stops the read", async () => {
    let judged = "";
    const t = pageTicket(tok, pageFacts(page)!, false);
    const r = await pageByTicket(page, () => null, (f) => pageTicketRefusal(tok, f, t, false), (real) => { judged = real; return true; });
    expect(r).toMatchObject({ status: 403 });
    expect(judged).toBe(pageFacts(page)!.real);
  });

  test("the serving code never opens the path again after the check", () => {
    const src = readFileSync(join(import.meta.dir, "../src/browse.ts"), "utf8");
    const body = (name: string) => {
      const at = src.indexOf(`function ${name}(`);
      const end = src.indexOf("\n}\n", at);
      expect(at).toBeGreaterThan(-1);
      return src.slice(at, end);
    };
    const serveSrc = body("pageByTicket") + body("streamFd") + body("convertFrom");
    for (const byName of ["Bun.file(", "readFile", "readHead(", "fileBytes(", "openSync(", "statSync(", "realpathSync(", "browseReal("]) {
      expect(serveSrc.includes(byName)).toBe(false);
    }
    expect(serveSrc.match(/openPage\(/g)?.length).toBe(1);
    // The signature on the path is proven before the path is opened.
    expect(body("pageByTicket").indexOf("pathRefusal()")).toBeGreaterThan(-1);
    expect(body("pageByTicket").indexOf("pathRefusal()")).toBeLessThan(body("pageByTicket").indexOf("openPage("));
    expect(body("openPage")).toContain("O_NOFOLLOW");
    expect(body("openPage")).toContain("fstatSync(fd)");
  });
});
