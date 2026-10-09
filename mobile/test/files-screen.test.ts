/*
 * The rules of the Files screen that live in source, because nothing here can
 * mount a screen: Back goes through the one decision, the screen can be pulled,
 * the crumbs are the size the design names, it is read-only, and the two ways
 * in (the terminal's icon, the diff's "Whole file") still land on it.
 */
import { expect, test } from "bun:test";

const read = (p: string): Promise<string> => Bun.file(new URL(p, import.meta.url)).text();
const files = await read("../app/files.tsx");
const diff = await read("../app/git-diff.tsx");
const terminal = await read("../app/(tabs)/terminal.tsx");

test("the hardware Back button and the header arrow are the same decision", () => {
  expect(files).toContain("BackHandler.addEventListener");
  expect(files.match(/backTarget\(s\)/g)?.length).toBe(2);
  expect(files).toContain("headerLeft");
  expect(files).toContain("onPress={goBack}");
});

test("the folder and the file can be pulled to refresh, through one helper", () => {
  expect(files.match(/<RefreshControl\s/g)?.length).toBe(1);
  expect(files).toContain("refreshControl={pull(() => read(open))}");
  expect(files).toContain("refreshControl={pull(() => Promise.all([loadTree(s.rel), loadChanged()]))}");
});

test("the crumbs are 40 tall with 12 of padding, pressed, and 4 of reach above and below", () => {
  const at = files.indexOf("accessibilityLabel={last ?");
  expect(at).toBeGreaterThan(0);
  const crumb = files.slice(at, files.indexOf("</Pressable>", at));
  expect(crumb).toContain("height: 40");
  expect(crumb).toContain("paddingHorizontal: 12");
  expect(crumb).toContain("hitSlop={{ top: 4, bottom: 4 }}");
  expect(crumb).toContain("pressed ? C.bg3");
});

test("it reads and never writes: only GETs, none of the Git write routes", () => {
  const code = files.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
  expect(code).not.toMatch(/method:\s*"(POST|PUT|DELETE|PATCH)"/);
  expect(code).not.toMatch(/"\/git\/(stage|unstage|commit|push|checkout|stash|branch)/);
  for (const route of ["/files/tree", "/files/read", "/git/changes-v2?mode=working", "/git/changes-v2?mode=committed"]) {
    expect(code).toContain(route);
  }
});

test("the diff's Whole file opens this screen on the file, and the terminal's icon still opens it on the folder", () => {
  expect(diff).toContain('pathname: "/files", params: { root: String(root), file: String(path) }');
  expect(files).toContain("useLocalSearchParams<{ root: string; file?: string }>");
  expect(terminal).toContain('router.push({ pathname: "/files", params: { root: open.where } })');
});

test("See diff opens the diff screen with what the model decided", () => {
  expect(files).toContain('pathname: "/git-diff", params: diffParams(here)');
});

test("both states rise above the keyboard by the measured overlap, not by KeyboardAvoidingView", () => {
  // KeyboardAvoidingView measures against its parent, so under a native header
  // the Find bar stayed 60 points under the keys (measured on the emulator).
  expect(files).not.toContain("KeyboardAvoidingView");
  expect(files.match(/paddingBottom: lifted\.lift/g)?.length).toBe(2);
});

/** Body of `const <name> = useCallback(async (` up to the next `}, [` deps line. */
const callback = (name: string): string => {
  const at = files.indexOf(`const ${name} = useCallback(`);
  expect(at).toBeGreaterThan(0);
  return files.slice(at, files.indexOf("}, [", at));
};

test("a folder answer that lands after the screen moved on is dropped", () => {
  // Folder A slow, folder B fast: without the check A's rows were drawn under B's crumbs.
  const load = callback("loadTree");
  expect(load.indexOf("treeFor.current !== rel")).toBeGreaterThan(load.indexOf("await ask"));
  expect(load.indexOf("treeFor.current !== rel")).toBeLessThan(load.indexOf("setEntries("));
  expect(files).toContain("treeFor.current = s.rel;");
});

test("a file answer that lands after the screen moved on is dropped", () => {
  const read = callback("read");
  expect(read.indexOf("readFor.current !== rel")).toBeGreaterThan(read.indexOf("await ask"));
  expect(read.indexOf("readFor.current !== rel")).toBeLessThan(read.indexOf("setText("));
});

test("a file that cannot be read does not leave its card on the folder landing", () => {
  const read = callback("read");
  expect(read).toContain("setFileError(");
  expect(read).not.toContain("setError(");
  // The landing (the folder view) only ever draws the folder's own error.
  const landing = files.slice(files.indexOf("entries === null && !error"));
  expect(landing).not.toContain("fileError");
  expect(files).toContain("{fileError ? <View");
});

test("the diff's Whole file opens as arrived, so Back returns to the diff", () => {
  expect(files).toContain("openFile(String(file), false, true)");
});

test("Find says when it only searched the part of the file that was drawn", () => {
  expect(files).toContain("findLabel(at, found.length, query, body !== null && body.length > CAP ? CAP : undefined)");
});

test("the terminal's dirty dot starts clean for another checkout", () => {
  const at = terminal.indexOf("const dotFor = useRef");
  expect(at).toBeGreaterThan(0);
  const effect = terminal.slice(at, terminal.indexOf("}, [host, where]));", at));
  expect(effect).toContain("if (dotFor.current !== where) { dotFor.current = where; setDirty(false); }");
});
