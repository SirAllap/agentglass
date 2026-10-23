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
    expect(deskGated("/finder/bookmarksX")).toBe(false);
  });
});

const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
test("the shared post sends the desk key on a gated route", () => {
  const at = api.indexOf("async function post<T>(");
  const body = api.slice(at, api.indexOf("\n}\n", at));
  expect(body).toContain("deskGated(path)");
  expect(body).toContain("deskHeader()");
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
