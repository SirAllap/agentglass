/*
 * The tile shows the live worker on its card: a session whose folder names the key becomes the "Worker running"
 * header AND a line with its title, state and cost. This renders the tile with workerFor's own answer.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderTask } from "../../shared/providers.ts";
import type { AgentCard } from "../src/lib/derive.ts";
import { workerFor } from "../src/lib/jiraCardWork.ts";
import { TileBody } from "../src/components/jira/list/JiraTile.tsx";

const card = { id: "c5", key: "ORBIT-105", title: "Fix the ledger", status: "In Progress", statusKind: "open", assignees: [], people: [] } as unknown as ProviderTask;
const agent = { key: "k", source_app: "orbit", session_id: "s1", model_name: "claude-sonnet-5-5", status: "working", cwd: "/work/ORBIT-105-ledger-fix", lastSeen: 5, cost: 0.42 } as unknown as AgentCard;

describe("the tile's worker line", () => {
  test("a live session in the card's folder is its worker, and the tile draws the line and the header", () => {
    const worker = workerFor("ORBIT-105", [agent]);
    expect(worker).not.toBeNull();
    const html = renderToStaticMarkup(createElement(TileBody, { card, blockedBy: [], worker, nextStatus: null, writable: true }));
    expect(html).toContain("agx-jb-work");
    expect(html).toContain("$0.42");
    expect(html).toContain("working");
    expect(html).toContain('data-kind="worker"');
  });
  test("no worker, no line", () => {
    const html = renderToStaticMarkup(createElement(TileBody, { card, blockedBy: [], worker: null, nextStatus: null, writable: true }));
    expect(html).not.toContain("agx-jb-work");
  });
});
