/*
 * What the documentation says `/search` finds, against what is indexed.
 *
 * The search index is built by `ftsText`: the prompt, the command, the path or
 * pattern, the message and the final answer of an event. A tool's output is not
 * in it — it is the largest part of most events and the index would be mostly
 * noise. The API table said "prompts, commands and outputs" for as long as
 * nobody checked, and a reader who searches for a string a command printed
 * finds nothing and concludes the search is broken.
 */
import { describe, expect, test } from "bun:test";
import { ftsText } from "../src/db.ts";
import { docContaining } from "./docs.ts";

const event = {
  source_app: "orbit",
  session_id: "s-1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  error_text: null,
  payload: {
    tool_input: { command: "make build-orbit" },
    tool_response: { stdout: "linked target zebra-artefact" },
  },
};

describe("what /search is documented to cover", () => {
  test("the command is indexed and the tool's output is not", () => {
    const text = ftsText(event);
    expect(text).toContain("make build-orbit");
    expect(text).not.toContain("zebra-artefact");
  });

  test("so the API table does not promise outputs", () => {
    const { text } = docContaining("`/search?q=`", "the /search row of the API table");
    const row = text.split("\n").find((l) => l.includes("`/search?q=`"));
    expect(row).toBeDefined();
    expect(row!).toContain("full-text search over");
    expect(row!).not.toMatch(/\boutputs\b/i);
    expect(row!).toContain("not tool output");
  });
});
