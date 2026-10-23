// "Why it stopped": the sentence drawn from what the host kept about a plugin
// that died within seconds of starting, decided here so no renderer is needed.
import { describe, expect, test } from "bun:test";
import { stopReason } from "../src/lib/pluginStopped.ts";

describe("stopReason", () => {
  test("nothing kept: nothing to say", () => {
    expect(stopReason({})).toBeNull();
  });

  test("an exit code and what it wrote", () => {
    const r = stopReason({ lastExit: { code: 3, signal: null, stderrTail: "ModuleNotFoundError: widget", afterMs: 420 } });
    expect(r!.headline).toBe("It exited with code 3 420 ms after starting.");
    expect(r!.detail).toBe("ModuleNotFoundError: widget");
  });

  test("a signal has no code", () => {
    const r = stopReason({ lastExit: { code: null, signal: "SIGSEGV", stderrTail: "", afterMs: 1500 } });
    expect(r!.headline).toBe("It was stopped by SIGSEGV 1.5 s after starting.");
    expect(r!.detail).toBe("");
  });

  test("the box's own failure alone, and said once when the tail repeats it", () => {
    expect(stopReason({ lastBoxFailure: "bwrap: no such path" })!.headline).toBe("The box it runs in failed to start.");
    const both = stopReason({
      lastExit: { code: 1, signal: null, stderrTail: "bwrap: no such path", afterMs: 3 },
      lastBoxFailure: "bwrap: no such path",
    });
    expect(both!.detail).toBe("bwrap: no such path");
  });
});

describe("where it is drawn", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  test("the settings card and the not-running panel both mount it", async () => {
    expect(await read("../src/components/PluginsPane.tsx")).toContain("<PluginWhyStopped plugin={plugin} />");
    expect(await read("../src/components/plugins/PluginNotRunning.tsx")).toContain("<PluginWhyStopped plugin={why} />");
  });
});
