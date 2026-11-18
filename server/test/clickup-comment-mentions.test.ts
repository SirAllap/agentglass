/* ClickUp comment pieces to the people they name (drawn as chips by the card). */
import { expect, test } from "bun:test";
import { commentMentions } from "../src/clickup.ts";

const tag = (id: number, username: string) => ({ type: "tag", text: `@${username}`, user: { id, username, initials: "AO", color: "#7d53de" } });

test("tag pieces become people, once each, in order", () => {
  const blocks = [{ text: "Hi " }, tag(7, "Ada Orbit"), { text: " and " }, tag(9, "Bo Acme"), tag(7, "Ada Orbit"), { text: "\n" }];
  expect(commentMentions(blocks)).toEqual([{ id: "7", name: "Ada Orbit" }, { id: "9", name: "Bo Acme" }]);
});

test("plain text, a tag with no id or no name names nobody", () => {
  expect(commentMentions([{ text: "@ada" }, { type: "tag", user: {} }, { type: "tag", user: { id: 3, username: " " } }])).toEqual([]);
});
