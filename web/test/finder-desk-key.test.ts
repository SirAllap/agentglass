import { describe, expect, test } from "bun:test";
import { deskGated } from "../src/lib/deskGate.ts";
import { toggledPlaces } from "../src/lib/finderPins.ts";
import type { PinnedPlace } from "../../shared/types.ts";

// "Pin to sidebar" did nothing in the desktop app: the call was made without the app's desk key and refused.
describe("which calls carry the desk key", () => {
  test("pinning does, a plain read does not", () => {
    expect(deskGated("/finder/bookmarks")).toBe(true);
    expect(deskGated("/finder/bookmarks?x=1")).toBe(true);
    expect(deskGated("/browse/list")).toBe(false);
    expect(deskGated("/finder/openwith")).toBe(false);
    expect(deskGated("/preview/open")).toBe(false);
    expect(deskGated("/finder/bookmarksX")).toBe(false);
  });
});

const idx = await Bun.file(new URL("../../server/src/index.ts", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
test("the shared post sends the desk key on a gated route", () => {
  const at = api.indexOf("async function post<T>(");
  const body = api.slice(at, api.indexOf("\n}\n", at));
  expect(body).toContain("deskGated(path)");
  expect(body).toContain("deskHeader()");
});

// Connecting a server for a person was refused as "only the desktop app" from inside the desktop app, for the same reason.
describe("every route the server judges by the desk key sends it", () => {
  test("each route the server gates is on the list", () => {
    for (const r of ["/finder/remotes/connect", "/finder/remotes/answer", "/finder/remotes/cancel", "/finder/devices/mount", "/finder/devices/unlock", "/finder/actions/run", "/finder/actions/save", "/finder/openwith/launch", "/fs/op", "/finder/bookmarks"]) {
      expect(deskGated(r)).toBe(true);
      // and the server still gates it by the key: the list and the server move together
      const name = r.startsWith("/finder/devices/") ? "/finder/devices/" : r.startsWith("/finder/actions/") ? "/finder/actions" : r.startsWith("/fs/") ? "/fs/" : r;
      expect(idx).toContain(`"${name}`);
    }
  });
  // Judged by mayPublishReview, which asks for the key whenever the app holds one:
  // without it the window's own press of the keyring switch became an agent's
  // request (on) or a 403 (off), and Clean up disk answered 403 to the person.
  test("the keyring switch, its re-read and the disk clean are on the list", () => {
    for (const r of ["/keyring/toggle", "/keyring/rehydrate", "/machine/disk-clean/run"]) {
      expect(deskGated(r)).toBe(true);
      const at = idx.indexOf(`pathname === "${r}"`);
      expect(at).toBeGreaterThan(-1);
      expect(idx.slice(at, idx.indexOf("\n    }\n", at))).toContain("mayPublishReview(req, caller)");
    }
    expect(deskGated("/keyring")).toBe(false);
    expect(deskGated("/machine/disk-clean")).toBe(false);
  });
  // The same hole on Data & privacy and the Jira write switches: judged by
  // mayPublishReview and posted through the shared post without the key, so
  // the person's erase was a 403 and a retention or write-kind save became an
  // agent's request. /orchestration sends the key itself (deskHeader()).
  test("data retention, erase history and the Jira write kinds are on the list", () => {
    for (const r of ["/privacy/retention", "/privacy/erase-history", "/jira/write-kinds"]) {
      expect(deskGated(r)).toBe(true);
      const at = idx.indexOf(`pathname === "${r}"`);
      expect(at).toBeGreaterThan(-1);
      expect(idx.slice(at, idx.indexOf("\n    }\n", at))).toContain("mayPublishReview(req, caller)");
    }
    expect(api).toMatch(/"\/orchestration", \{ root, policy \}, deskHeader\(\)/);
  });
  test("a read of the same family does not", () => {
    for (const r of ["/finder/devices", "/finder/network", "/finder/actions", "/finder/openwith?path=/a"]) expect(deskGated(r)).toBe(false);
  });
  test("the app's remote connect and answer go through the shared post", () => {
    expect(api).toMatch(/remoteConnect: \(uri: string\) => post</);
    expect(api).toMatch(/remoteAnswer: [^\n]*=> post</);
    expect(api).toMatch(/volumeAct: [^\n]*=> post</);
  });
});

describe("a pin shows at once", () => {
  const docs: PinnedPlace = { uri: "file:///home/ann/Documents/orbit", label: "orbit", path: "/home/ann/Documents/orbit" };
  const remote: PinnedPlace = { uri: "sftp://ann@10.0.0.7/home/ann", label: "Workstation" };
  test("a new folder is added at the end with its name", () => {
    expect(toggledPlaces([remote], "/home/ann/Documents/orbit")).toEqual([remote, docs]);
  });
  test("a pinned one is removed, the remote stays", () => {
    expect(toggledPlaces([docs, remote], "/home/ann/Documents/orbit/")).toEqual([remote]);
  });
  test("the path is encoded as the file does", () => {
    expect(toggledPlaces([], "/home/ann/a b")[0]!.uri).toBe("file:///home/ann/a%20b");
  });
});
