/*
 * The Containers view, drawn: the rules the mockup states that a screen could
 * silently lose. There is no DOM under `bun test`, so these read the markup the
 * first paint produces and the source of the files that must never poll.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockerContainer, DockerOverview, DockerStat } from "../../shared/types.ts";
import { KINDS, type ContainerKind } from "../src/lib/dockerState.ts";
import { triage } from "../src/lib/dockerTriage.ts";
import { groupsView, mapGroups } from "../src/lib/dockerView.ts";
import { AnswerCards, Say } from "../src/components/docker/AnswerCards.tsx";
import { ContainerRow } from "../src/components/docker/ContainerRow.tsx";
import { DockerHeader } from "../src/components/docker/Header.tsx";
import { Glyph, Square } from "../src/components/docker/Glyphs.tsx";
import { MapStrip } from "../src/components/docker/MapStrip.tsx";
import { Navigator } from "../src/components/docker/Navigator.tsx";
import { SplitList } from "../src/components/docker/SplitList.tsx";
import { StackCard } from "../src/components/docker/StackCard.tsx";
import { DaemonBanner, EmptyCard, ListSkeleton, NotInstalled } from "../src/components/docker/States.tsx";

const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const h = React.createElement;
const noop = () => {};

const c = (over: Partial<DockerContainer> & { id: string }): DockerContainer => ({
  name: `orbit-${over.id}-1`, image: "acme/orbit:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: over.id, workingDir: "/home/dev/code/orbit",
  runningFor: "4 hours ago", size: "", ...over,
});
const web = (host: number) => ({ host, hostEnd: host, hostIp: "0.0.0.0", container: host, containerEnd: host, proto: "tcp" as const, web: true });
const stat = (cpu: number, mem: number): DockerStat => ({ id: "api", cpu, mem, memUsage: "212MiB / 7.7GiB", netIO: "", blockIO: "", pids: 3 });

const rowProps = (over: Record<string, unknown> = {}) => ({
  c: c({ id: "api", portList: [web(3100)] }), stat: stat(12.3, 40), selected: false, dense: false, readOnly: false, busy: false,
  confirm: null, menuOpen: false, onSelect: noop, onVerb: noop, onMenu: noop, onOpenPort: noop, onConfirm: noop, ...over,
});

describe("a state is a shape and a word, never only a colour", () => {
  test("each of the nine kinds has its own drawing and a spoken word", () => {
    const kinds = Object.keys(KINDS) as ContainerKind[];
    const drawn = kinds.map((k) => draw(h(Glyph, { kind: k })));
    expect(new Set(drawn).size).toBe(kinds.length);
    kinds.forEach((k, i) => expect(drawn[i]).toContain(`aria-label="${KINDS[k].word}"`));
  });
  test("a square is a button only when it is given somewhere to go", () => {
    expect(draw(h(Square, { kind: "crash", title: "api: exited with an error", onPick: noop }))).toContain("<button");
    expect(draw(h(Square, { kind: "crash", small: true }))).not.toContain("<button");
  });
});

describe("a container row", () => {
  test("shows the name, the sub-line and exactly one action", () => {
    const html = draw(h(ContainerRow, rowProps()));
    expect(html).toContain("api");
    expect(html).toContain("acme/orbit:dev");
    expect((html.match(/data-verb="/g) ?? []).length).toBe(1);
    expect(html).toContain('data-verb="restart"');
  });
  test("the action follows the state: a paused one resumes, a stopped one starts, a dead one removes", () => {
    expect(draw(h(ContainerRow, rowProps({ c: c({ id: "api", state: "paused" }) })))).toContain('data-verb="unpause"');
    expect(draw(h(ContainerRow, rowProps({ c: c({ id: "api", state: "exited", status: "Exited (0) 1 hour ago" }) })))).toContain('data-verb="start"');
    expect(draw(h(ContainerRow, rowProps({ c: c({ id: "api", state: "dead", status: "Dead" }) })))).toContain('data-verb="rm"');
  });
  test("read-only disables the action and says why", () => {
    const html = draw(h(ContainerRow, rowProps({ readOnly: true })));
    expect(html).toContain("Read-only instance: writes are turned off");
    expect(html).toMatch(/data-verb="restart"[^>]*disabled|disabled[^>]*data-verb="restart"/);
  });
  test("the meters go amber at 50 and 80", () => {
    expect(draw(h(ContainerRow, rowProps({ stat: stat(49, 79) })))).not.toContain('data-hot="true"');
    const hot = draw(h(ContainerRow, rowProps({ stat: stat(50, 10) })));
    expect((hot.match(/data-hot="true"/g) ?? []).length).toBe(1);
  });
  test("a web port is a button that opens it; a database port is only text", () => {
    expect(draw(h(ContainerRow, rowProps()))).toContain("localhost:3100");
    expect(draw(h(ContainerRow, rowProps()))).toContain('data-port="web"');
    const plain = draw(h(ContainerRow, rowProps({ c: c({ id: "db", portList: [{ ...web(5433), web: false }] }) })));
    expect(plain).toContain(":5433");
    expect(plain).not.toContain('data-port="web"');
  });
  test("a container that needs you is marked, and the owner badge names another checkout", () => {
    const sick = draw(h(ContainerRow, rowProps({ c: c({ id: "api", health: "unhealthy" }) })));
    expect(sick).toContain('data-need="true"');
    expect(sick).toContain("unhealthy");
    const foreign = draw(h(ContainerRow, rowProps({ c: c({ id: "api", owner: { worktree: "orbit-1042", branch: "b", foreign: true, path: "/p" } }) })));
    expect(foreign).toContain("orbit-1042");
  });
  test("the confirm is inline, names the container and says the volumes stay", () => {
    const html = draw(h(ContainerRow, rowProps({ confirm: "rm" })));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("its volumes stay");
  });
  test("dense drops the sub-line", () => {
    expect(draw(h(ContainerRow, rowProps({ dense: true })))).not.toContain("acme/orbit:dev</span>");
  });
});

describe("a stack card", () => {
  const cs = [c({ id: "api", health: "unhealthy" }), c({ id: "db" }), c({ id: "worker", state: "exited", status: "Exited (0) 1 hour ago" })];
  const group = groupsView(cs, { groupBy: "stack", q: "", answer: null, open: {} })[0]!;
  const card = (over: Record<string, unknown> = {}) => draw(h(StackCard, {
    group, readOnly: false, busy: false, folded: false, menuOpen: false, confirm: null,
    onToggle: noop, onMenu: noop, onGroupVerb: noop, onConfirm: noop, ...over,
  }, h("div", null, "ROWS")));
  test("says how many are up and how many need you", () => {
    expect(card()).toContain("2/3 up · <b>1 needs you</b>");
  });
  test("one square per container, and the column labels sit on the rows' grid", () => {
    const html = card();
    expect((html.match(/data-sq="/g) ?? []).length).toBe(3);
    expect(html).toContain("CPU");
    expect(html).toContain("Memory");
    expect(html).toContain("Port");
  });
  test("folded hides the rows and the labels", () => {
    const html = card({ folded: true });
    expect(html).not.toContain("ROWS");
    expect(html).not.toContain("Memory");
    expect(html).toContain('aria-expanded="false"');
  });
  test("one button: Restart all while anything runs, Start all when nothing does", () => {
    expect(card()).toContain("Restart all");
    const idle = groupsView([c({ id: "a", state: "exited", status: "Exited (0) 1 hour ago" })], { groupBy: "stack", q: "", answer: null, open: {} })[0]!;
    expect(card({ group: idle })).toContain("Start all");
  });
  test("names the checkout in a chip, and read-only disables the group verbs", () => {
    const owned = groupsView([c({ id: "a", owner: { worktree: "orbit-1042", branch: "b", foreign: false, path: "/p" } })], { groupBy: "stack", q: "", answer: null, open: {} })[0]!;
    expect(card({ group: owned })).toContain("orbit-1042");
    expect(card({ readOnly: true })).toMatch(/Restart all[\s\S]*<\/button>/);
    expect(card({ readOnly: true })).toContain("Read-only instance: writes are turned off");
  });
  test("a group confirm is inline and counts what it will touch", () => {
    expect(card({ confirm: { verb: "restart", n: 2 } })).toContain("restart 2 containers in");
  });
});

describe("the sentence, the answers and the map", () => {
  const fleet = [c({ id: "a", health: "unhealthy" }), c({ id: "b" }), c({ id: "c", state: "exited", status: "Exited (0) 1 hour ago" })];
  const t = triage(fleet);
  test("the sentence leads with the count", () => {
    expect(draw(h(Say, { t }))).toContain("1 of 3 containers needs you.");
  });
  test("three cards that are filters, and one with nothing in it cannot be pressed", () => {
    const html = draw(h(AnswerCards, { t, active: "need", onPick: noop }));
    expect(html).toContain("Need you");
    expect(html).toContain("Running fine");
    expect(html).toContain("Stopped");
    expect(html).toContain('aria-pressed="true"');
    const none = draw(h(AnswerCards, { t: triage([c({ id: "a" })]), active: null, onPick: noop }));
    expect(none).toMatch(/Need you[\s\S]*?disabled|disabled[\s\S]*?Need you/);
  });
  test("the map has one square per container and dims what the filter hides", () => {
    const html = draw(h(MapStrip, { groups: mapGroups(fleet, "stack"), inFilter: new Set(["a"]), selected: "a", onPick: noop }));
    expect((html.match(/data-sq="/g) ?? []).length).toBe(3);
    expect((html.match(/data-dim="true"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-current="true"');
  });
});

describe("the split list", () => {
  test("is narrow rows with the glyph, the name and the CPU, and a Clear bar for an answer filter", () => {
    const cs = [c({ id: "api", health: "unhealthy" }), c({ id: "db" })];
    const groups = groupsView(cs, { groupBy: "stack", q: "", answer: "need", open: {} });
    const html = draw(h(SplitList, { groups, stats: { api: stat(12.3, 4) }, selected: "api", answer: "need", onSelect: noop, onClearAnswer: noop }));
    expect(html).toContain("12.3%");
    expect(html).toContain("Need you");
    expect(html).toContain("Clear");
  });
});

describe("the header", () => {
  const ov = { available: true, writeEnabled: true, version: "27.3.1", containers: [], images: [], volumes: [], networks: [], at: 1 } as DockerOverview;
  const head = (over: Record<string, unknown> = {}) => draw(h(DockerHeader, {
    situation: "normal", version: "27.3.1", fresh: { text: "Live · 5s ago", warn: false }, scope: null, q: "", onQ: noop,
    groupBy: "stack", onGroupBy: noop, layout: "list", onLayout: noop, dense: false, onDense: noop, readOnly: false,
    onRefresh: noop, refreshing: false, showFilter: true, showView: true, back: null, ...over,
  }));
  void ov;
  test("title, engine, freshness, filter, grouping, layout, dense and refresh are all there", () => {
    const html = head();
    for (const s of ["Docker", "Engine 27.3.1", "Live · 5s ago", "By stack", "By worktree", "List", "Split", "Dense", "Refresh"]) expect(html).toContain(s);
    expect(html).toContain('aria-label="Filter containers"');
  });
  test("a downed daemon is amber and disables the filter", () => {
    const html = head({ situation: "down", fresh: { text: "retrying · last state 4 min old", warn: true } });
    expect(html).toContain("retrying · last state 4 min old");
    expect(html).toContain('data-warn="true"');
    expect(html).not.toContain("Engine 27.3.1");
  });
  test("the scope pill and the read-only badge", () => {
    const html = head({ scope: { all: true, project: "orbit", before: "No ", after: " containers · showing all", title: "t" }, readOnly: true });
    expect(html).toContain("showing all");
    expect(html).toContain("Read-only");
  });
  test("a way back, when a container is open", () => {
    expect(head({ back: noop })).toContain("Back to all containers");
    expect(head()).not.toContain("Back to all containers");
  });
});

describe("the navigator", () => {
  test("five sections, the amber need count on Containers, and the keys", () => {
    const html = draw(h(Navigator, { section: "containers", counts: { need: 1, containers: 14, images: 3, volumes: 2, networks: 4 }, onPick: noop }));
    for (const s of ["Containers", "Images", "Volumes", "Networks", "Disk"]) expect(html).toContain(s);
    expect(html).toContain("<b>1</b>");
    expect(html).toContain(">14<");
    for (const k of ["j", "k", "r", "s", "Enter", "Esc"]) expect(html).toContain(`>${k}</kbd>`);
    expect(html).toContain("event stream");
  });
  test("without a count the Containers row is only its total", () => {
    const html = draw(h(Navigator, { section: "images", counts: { need: 0, containers: 14, images: 3, volumes: 2, networks: 4 }, onPick: noop }));
    expect(html).not.toContain("<b>0</b>");
  });
});

describe("the states", () => {
  test("loading is a skeleton, not a spinner and not blank", () => {
    expect(draw(h(ListSkeleton))).toContain("dk-shim");
  });
  test("not installed gives the install guidance", () => {
    expect(draw(h(NotInstalled, { reason: undefined, onCheck: noop }))).toContain("Docker isn&#x27;t installed");
  });
  test("empty tells you what starts one", () => {
    const html = draw(h(EmptyCard, { all: false, project: "orbit", onConsole: noop }));
    expect(html).toContain("No containers yet");
    expect(html).toContain("docker compose up");
  });
  test("daemon down is an amber banner with Try now", () => {
    const html = draw(h(DaemonBanner, { error: "Cannot connect", age: "4 min", onTry: noop }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try now");
    expect(html).toContain("4 min");
  });
});

describe("nothing in the Containers view polls", () => {
  const dir = new URL("../src/components/docker/", import.meta.url).pathname;
  const data = new URL("../src/lib/useDockerData.ts", import.meta.url).pathname;
  const files = [new URL("../src/components/DockerPanel.tsx", import.meta.url).pathname, data, ...readdirSync(dir).map((f) => dir + f)];
  test("no setInterval and no usePoll in the panel, its data hook or anything under docker/", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
      expect(`${f}: ${/setInterval\(|usePoll/.test(src)}`).toBe(`${f}: false`);
    }
  });
  test("the panel listens to the live feed", () => {
    expect(readFileSync(data, "utf8")).toContain("useDockerLive(");
    expect(readFileSync(files[0]!, "utf8")).toContain("useDockerData(");
  });
});
