/*
 * The workspace shell is not re-rendered by the live socket.
 *
 * The root re-renders on every flush of the socket, up to five times a second
 * with agents working. The shell under it holds the rail, every mounted view
 * and both boards, and it was given a fresh render prop (the Starboard) and
 * three fresh arrows on each of those renders: the shell re-rendered, and the
 * views' own memo failed on the fresh arrow, so the terminal, the browser and
 * every hidden view were rebuilt each time. The Starboard's data now waits in
 * a feed, the shell is compared by identity, and what the root hands it is
 * held.
 */
import { describe, expect, test } from "bun:test";
import { feed, sameFields } from "../src/lib/dashFeed.ts";

const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const shell = await Bun.file(new URL("../src/components/workspace/Workspace.tsx", import.meta.url)).text();

describe("the feed the Starboard reads", () => {
  const rows = [{ id: 1 }];
  const pick = () => {};

  test("a publish that changed no field tells nobody", () => {
    const f = feed<{ rows: { id: number }[]; epm: number; onPick: () => void }>();
    let told = 0;
    f.subscribe(() => { told++; });
    expect(f.publish({ rows, epm: 3, onPick: pick })).toBe(true);
    // The root publishes after every render: same array, same number, same callback.
    expect(f.publish({ rows, epm: 3, onPick: pick })).toBe(false);
    expect(told).toBe(1);
    expect(f.publish({ rows, epm: 4, onPick: pick })).toBe(true);
    // A new array with the same contents is a change: identity, as React compares props.
    expect(f.publish({ rows: [{ id: 1 }], epm: 4, onPick: pick })).toBe(true);
    expect(told).toBe(3);
    expect(f.get()?.epm).toBe(4);
  });

  test("a reader that left is not told, and nothing is read before the first publish", () => {
    const f = feed<{ n: number }>();
    expect(f.get()).toBeNull();
    let told = 0;
    const leave = f.subscribe(() => { told++; });
    leave();
    f.publish({ n: 1 });
    expect(told).toBe(0);
  });

  test("a field that disappeared is a change", () => {
    expect(sameFields<{ a: number; b?: number }>({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameFields({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameFields(null, { a: 1 })).toBe(false);
  });
});

describe("what the root hands the shell", () => {
  /** The `<Workspace … />` element in the root, comments taken out. */
  const element = (() => {
    const at = app.indexOf("<Workspace\n");
    expect(at).toBeGreaterThan(-1);
    const end = app.indexOf("\n      />}", at);
    expect(end).toBeGreaterThan(at);
    return app.slice(at, end).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  })();

  test("no arrow is written in the element: each one would be a new prop on every flush", () => {
    expect(element).not.toContain("=>");
    expect(element).toContain("dashboard={renderDash}");
    expect(element).toContain("tick={tick}");
  });

  test("the callbacks it is given are held", () => {
    for (const name of ["openProject", "openSkills", "openSettingsModal", "openMachine"]) {
      expect(app, name).toContain(`const ${name} = useCallback(`);
      expect(element, name).toContain(`={${name}}`);
    }
    // One function for the life of the page, outside the component.
    expect(app).toContain("\nconst renderDash = (active: boolean) => <DashHost active={active} />;");
  });

  test("the shell is compared by identity, and the Starboard listens only while it is on screen", () => {
    expect(shell).toContain("export const Workspace = memo(WorkspaceImpl);");
    expect(app).toContain("useSyncExternalStore(active ? dashFeed.subscribe : noFeed, dashFeed.get, dashFeed.get)");
  });
});
