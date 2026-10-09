import { describe, expect, test } from "bun:test";
import {
  afterJump, canOpenInBrowser, copyLabel, dirsFirst, fileKind, flash, focusSelection, NO_BROWSE, pathBar, pathInputText, pageUrl, placeSections, recentRow, switchTab, type BrowseState,
} from "../src/lib/paletteModel.ts";

const HOME = "/home/dev";

describe("the path bar", () => {
  test("home is the first segment and the rest follow it", () => {
    expect(pathBar("/home/dev/brain/memory/orbit", HOME)).toEqual([
      { label: "Home", path: "/home/dev", home: true, last: false },
      { label: "brain", path: "/home/dev/brain", last: false },
      { label: "memory", path: "/home/dev/brain/memory", last: false },
      { label: "orbit", path: "/home/dev/brain/memory/orbit", last: true },
    ]);
  });

  test("home itself is one segment, and it is where you are", () => {
    expect(pathBar(HOME, HOME)).toEqual([{ label: "Home", path: HOME, home: true, last: true }]);
  });

  test("outside home the bar starts at the filesystem root", () => {
    expect(pathBar("/srv/data", HOME).map((s) => s.label)).toEqual(["/", "srv", "data"]);
    expect(pathBar("/srv/data", HOME)[0]).toMatchObject({ path: "/" });
  });

  test("a sibling of home is not under home", () => {
    expect(pathBar("/home/devops/x", HOME).map((s) => s.label)).toEqual(["/", "home", "devops", "x"]);
  });

  test("exactly one segment is current, a trailing slash adds none, and nothing is nothing", () => {
    const bar = pathBar("/home/dev/a/", HOME);
    expect(bar.filter((s) => s.last)).toHaveLength(1);
    expect(bar.map((s) => s.label)).toEqual(["Home", "a"]);
    expect(pathBar("", HOME)).toEqual([]);
    expect(pathBar("/", HOME)).toEqual([]);
  });
});

describe("each tab owns its folder", () => {
  const machine: BrowseState = { q: "", browsePath: "/home/dev/brain/memory/orbit" };

  test("leaving Machine does not carry its folder to Name", () => {
    const r = switchTab<string>({}, "machine", machine, "names");
    expect(r.next).toEqual(NO_BROWSE);
    expect(r.next.browsePath).toBeNull();
  });

  test("coming back to Machine finds it where it was left", () => {
    const away = switchTab<string>({}, "machine", machine, "names");
    const back = switchTab<string>(away.stash, "names", away.next, "machine");
    expect(back.next).toEqual(machine);
  });

  test("Name keeps its own folder while Machine keeps another", () => {
    const nameState: BrowseState = { q: "web/", browsePath: "/work/orbit/web" };
    const a = switchTab<string>({}, "names", nameState, "machine");
    const b = switchTab<string>(a.stash, "machine", machine, "names");
    expect(b.next).toEqual(nameState);
  });

  test("it does not mutate what it was given", () => {
    const stash = {};
    switchTab<string>(stash, "machine", machine, "names");
    expect(stash).toEqual({});
  });
});

describe("the box says where you are", () => {
  test("a folder is its path, home folded to ~, ending in a slash", () => {
    expect(pathInputText("/home/dev/brain/orbit", HOME)).toBe("~/brain/orbit/");
    expect(pathInputText("/home/dev/brain/orbit/", HOME)).toBe("~/brain/orbit/");
    expect(pathInputText(HOME, HOME)).toBe("~/");
    expect(pathInputText("/srv/data", HOME)).toBe("/srv/data/");
    expect(pathInputText("/", HOME)).toBe("/");
  });

  test("before home is known the path is still a path", () => {
    expect(pathInputText("/home/dev/x", "")).toBe("/home/dev/x/");
  });

  test("a path is edited from its end, a last query is replaced whole", () => {
    expect(focusSelection("~/brain/orbit/")).toBe("end");
    expect(focusSelection("/srv/data/")).toBe("end");
    expect(focusSelection("guest-checkout")).toBe("all");
    expect(focusSelection("")).toBe("all");
  });

  test("a jump rewrites the box only if it was holding a path", () => {
    expect(afterJump("/home/dev/a", HOME, true)).toEqual({ browsePath: "/home/dev/a", q: "~/a/" });
    expect(afterJump("/home/dev/a", HOME, false)).toEqual({ browsePath: "/home/dev/a", q: "" });
  });
});

describe("copy feedback", () => {
  const fake = () => {
    const pending: { fn: () => void; ms: number; id: number }[] = [];
    let n = 0;
    return {
      pending,
      timers: {
        set: (fn: () => void, ms: number) => { const id = ++n; pending.push({ fn, ms, id }); return id; },
        clear: (id: unknown) => { const i = pending.findIndex((p) => p.id === id); if (i >= 0) pending.splice(i, 1); },
      },
    };
  };

  test("the button says Copied, then goes back", () => {
    expect(copyLabel("Copy path", false)).toBe("Copy path");
    expect(copyLabel("Copy path", true)).toBe("Copied");
  });

  test("on for 1.5 s and then off by itself", () => {
    const seen: boolean[] = []; const f = fake();
    flash((on) => seen.push(on), undefined, f.timers).fire();
    expect(seen).toEqual([true]);
    expect(f.pending[0]!.ms).toBe(1500);
    f.pending[0]!.fn();
    expect(seen).toEqual([true, false]);
  });

  test("a second press restarts the wait instead of being cut short by the first", () => {
    const seen: boolean[] = []; const f = fake();
    const c = flash((on) => seen.push(on), undefined, f.timers);
    c.fire(); c.fire();
    expect(f.pending).toHaveLength(1);
    c.cancel();
    expect(f.pending).toHaveLength(0);
  });
});

describe("the where menu as a sidebar", () => {
  const places = [
    { path: HOME, label: "Home" },
    { path: `${HOME}/Documents`, label: "Documents" },
    { path: `${HOME}/code`, label: "code" },
  ];

  test("places carry their path muted, and home is marked", () => {
    const s = placeSections(places, [], "", "", HOME);
    expect(s.places.map((r) => [r.name, r.sub])).toEqual([["Home", "~"], ["Documents", "~/Documents"], ["code", "~/code"]]);
    expect(s.places[0]!.home).toBe(true);
    expect(s.places[1]!.home).toBe(false);
  });

  test("a recent is its last segment in bold and its parent muted", () => {
    expect(recentRow(`${HOME}/brain/memory/orbit/`, HOME)).toMatchObject({ name: "orbit", sub: "~/brain/memory", recent: true });
    expect(recentRow("/srv", HOME)).toMatchObject({ name: "srv", sub: "/" });
  });

  test("recents leave out places and the folder you are in", () => {
    const s = placeSections(places, [`${HOME}/code`, `${HOME}/brain/orbit`, `${HOME}/here`], `${HOME}/here`, "", HOME);
    expect(s.recent.map((r) => r.path)).toEqual([`${HOME}/brain/orbit`]);
  });

  test("the filter narrows both sections and the flat list is places then recent", () => {
    const s = placeSections(places, [`${HOME}/brain/orbit`, `${HOME}/brain/docs`], "", "doc", HOME);
    expect(s.places.map((r) => r.name)).toEqual(["Documents"]);
    expect(s.recent.map((r) => r.name)).toEqual(["docs"]);
    expect(s.flat.map((r) => r.name)).toEqual(["Documents", "docs"]);
  });
});

describe("what a row looks like", () => {
  test("a name says what kind of thing it is", () => {
    expect(fileKind("orbit", true)).toBe("dir");
    expect(fileKind("MEMORY.md", false)).toBe("markdown");
    expect(fileKind("main.ts", false)).toBe("code");
    expect(fileKind("shot.PNG", false)).toBe("image");
    expect(fileKind("settings.json", false)).toBe("data");
    expect(fileKind("Makefile", false)).toBe("file");
    expect(fileKind(".env", false)).toBe("file");
    expect(fileKind("archive.tar.gz", false)).toBe("file");
  });

  test("a folder called like a file is still a folder", () => {
    expect(fileKind("build.md", true)).toBe("dir");
  });

  test("folders come first and each group keeps its order", () => {
    const rows = [
      { kind: "file", rel: "a.md" }, { kind: "dir", rel: "web" }, { kind: "file", rel: "b.md" }, { kind: "dir", rel: "docs" },
    ];
    expect(dirsFirst(rows).map((r) => r.rel)).toEqual(["web", "docs", "a.md", "b.md"]);
    expect(rows[0]!.rel).toBe("a.md");
  });
});

describe("open in browser", () => {
  test("pages, pictures and pdfs get it; code and folders do not", () => {
    for (const n of ["sheet.html", "a.HTM", "shot.png", "photo.JPEG", "logo.svg", "paper.pdf"]) expect(canOpenInBrowser(n)).toBe(true);
    for (const n of ["main.ts", "notes.md", "Makefile", "htmlnotes", "x.html.bak"]) expect(canOpenInBrowser(n)).toBe(false);
  });

  test("the address carries the path as one encoded value", () => {
    expect(pageUrl("http://127.0.0.1:4000", "/home/u/a b&c/sheet.html"))
      .toBe("http://127.0.0.1:4000/preview/page?path=%2Fhome%2Fu%2Fa%20b%26c%2Fsheet.html");
  });
});
