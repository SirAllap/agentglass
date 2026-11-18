/* Every refusal names its layer, its rule and the one place to change it. */
import { describe, expect, test } from "bun:test";
import { REFUSAL_WHERE, refusal, type RefusalLayer } from "../../shared/refusal.ts";
import { NETWORK_DOCKER_OFF } from "../src/agents/envelope.ts";

describe("refusal text", () => {
  test("each layer's sentence has the layer, the rule and a place", () => {
    for (const layer of Object.keys(REFUSAL_WHERE) as RefusalLayer[]) {
      const t = refusal(layer, "Bash(git push origin main:*)");
      expect(t).toContain(`${layer} layer`);
      expect(t).toContain("Bash(git push origin main:*)");
      expect(t).toContain("Change it at:");
    }
  });
  test("network and docker off by default say why and where", () => {
    expect(NETWORK_DOCKER_OFF).toContain("sandbox");
    expect(NETWORK_DOCKER_OFF).toContain("Settings ▸ Orchestration");
  });
});

describe("the start answer's defaults line", () => {
  test("says what moved and when", async () => {
    const { DEFAULTS_CHANGED } = await import("../src/agents/envelope.ts");
    for (const w of ["open by default", "close one", "Settings ▸ Orchestration"]) expect(DEFAULTS_CHANGED).toContain(w);
  });
});
