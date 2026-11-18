/*
 * "Still reading… Cancel", run: a read that never answers is aborted, the
 * request really rejects, and the board it leaves behind is no longer loading.
 */
import { describe, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { boardView, stoppedBoard } from "../src/lib/boardView.ts";
import { globalStubs } from "./stubGlobal";

/** The board shape the tests build: what a view answer carries, plus the two marks a stop sets. */
type Board = { tasks: unknown[]; statuses: unknown[]; fields: unknown[]; at: number; revalidating?: boolean; error?: string | null };

const stub = globalStubs();

describe("Cancel on a read that never answers", () => {
  test("the ClickUp board and card requests reject when aborted", async () => {
    let seen: AbortSignal | undefined;
    stub("fetch", (_u: unknown, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      seen = init?.signal;
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    }));
    for (const call of [
      (s: AbortSignal) => api.clickupView("v1", false, s),
      (s: AbortSignal) => api.clickupTask("t1", s),
    ]) {
      const ac = new AbortController();
      const p = call(ac.signal).then(() => "answered", (e: Error) => e.name);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toBe(ac.signal);
      ac.abort();
      expect(await p).toBe("AbortError");
    }
  });

  test("after Cancel a board with no rows is an error state, not loading, and says it stopped", () => {
    const empty: Board = { tasks: [], statuses: [], fields: [], at: 0 };
    const after = stoppedBoard(null, empty);
    expect(boardView({ data: null })).toBe("loading");
    expect(boardView({ data: after })).toBe("error");
    expect(after.error).toBe("Stopped. Nothing was read.");
  });

  test("after Cancel a board that had cached rows keeps them and drops the refreshing mark", () => {
    const had: Board = { tasks: [{ id: "a" }], statuses: [], fields: [], at: 5, revalidating: true };
    const after = stoppedBoard(had, { tasks: [], statuses: [], fields: [], at: 0 });
    expect(after.tasks).toEqual([{ id: "a" }]);
    expect(after.revalidating).toBe(false);
    expect(boardView({ data: after })).toBe("ready");
  });
});
