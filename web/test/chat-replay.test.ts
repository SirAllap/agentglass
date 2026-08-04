// A restarted panel replays the transcript. What it must not do is keep its own
// copy of the same turns alongside it — that is what put every message on
// screen twice after agentglass was rebuilt under a running chat. Attaching to
// the pane showed the prompt exactly once, which is how the duplicate was
// placed here rather than in the CLI.
import { describe, expect, test } from "bun:test";
import { mergeReplayed } from "../src/lib/chatReplay.ts";

const m = (ts: number, tag: string) => ({ ts, tag });

describe("mergeReplayed", () => {
  test("the persisted copy of a replayed turn is dropped", () => {
    // The panel had the turn; the transcript has it too, a moment later.
    const replayed = [m(100, "user:replayed"), m(200, "assistant:replayed")];
    const local = [m(90, "user:local"), m(150, "assistant:local")];
    expect(mergeReplayed(replayed, local).map((x) => x.tag))
      .toEqual(["user:replayed", "assistant:replayed"]);
  });

  test("something typed while the replay was in flight survives, and stays last", () => {
    const replayed = [m(100, "old")];
    const local = [m(90, "dupe"), m(120, "typed just now")];
    expect(mergeReplayed(replayed, local).map((x) => x.tag))
      .toEqual(["old", "typed just now"]);
  });

  test("nothing replayed leaves the panel exactly as it was", () => {
    const local = [m(1, "a"), m(2, "b")];
    expect(mergeReplayed([], local).map((x) => x.tag)).toEqual(["a", "b"]);
    // A copy, not the same array — the caller assigns this over its state.
    expect(mergeReplayed([], local)).not.toBe(local);
  });

  test("an empty panel takes the transcript whole", () => {
    const replayed = [m(1, "a"), m(2, "b")];
    expect(mergeReplayed(replayed, []).map((x) => x.tag)).toEqual(["a", "b"]);
  });

  test("a local message exactly on the cut is a copy, not a new one", () => {
    // Equal timestamps mean the transcript already covers it; keeping it would
    // reintroduce the duplicate for anything written in the same millisecond.
    expect(mergeReplayed([m(100, "replayed")], [m(100, "same moment")]).map((x) => x.tag))
      .toEqual(["replayed"]);
  });
});
