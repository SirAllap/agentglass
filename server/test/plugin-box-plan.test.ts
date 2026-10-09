/*
 * What a start does when a plugin declares a box: platform x probe x consent
 * x env, every cell. The probe says "missing" on macOS and Windows for every
 * plugin, always, while the server starts the plugin unboxed there; a screen
 * that read the probe alone told people "will not start" about a plugin that
 * starts.
 */
import { describe, expect, test } from "bun:test";
import { boxPlan, type BoxPlan } from "../../shared/pluginBoxPlan.ts";

const PLATFORMS = ["linux", "darwin", "win32"] as const;

function expected(platform: string, probeOk: boolean, allowUnboxed: boolean, envAllowsAll: boolean): BoxPlan {
  if (probeOk) return "box";
  if (platform !== "linux") return "unboxed-platform";
  return allowUnboxed || envAllowsAll ? "unboxed-consented" : "refuse";
}

describe("boxPlan", () => {
  for (const platform of PLATFORMS) {
    for (const probeOk of [true, false]) {
      for (const allowUnboxed of [true, false]) {
        for (const envAllowsAll of [true, false]) {
          test(`${platform}, probe ${probeOk ? "ok" : "fails"}, consent ${allowUnboxed}, env ${envAllowsAll}`, () => {
            expect(boxPlan({ platform, probeOk, allowUnboxed, envAllowsAll })).toBe(expected(platform, probeOk, allowUnboxed, envAllowsAll));
          });
        }
      }
    }
  }

  test("the cells that matter, spelled out: only Linux without a box or consent refuses", () => {
    expect(boxPlan({ platform: "linux", probeOk: false, envAllowsAll: false })).toBe("refuse");
    expect(boxPlan({ platform: "linux", probeOk: false, allowUnboxed: false, envAllowsAll: false })).toBe("refuse");
    expect(boxPlan({ platform: "darwin", probeOk: false, envAllowsAll: false })).toBe("unboxed-platform");
    expect(boxPlan({ platform: "win32", probeOk: false, envAllowsAll: false })).toBe("unboxed-platform");
  });
});
