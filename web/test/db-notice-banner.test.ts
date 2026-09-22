/*
 * A second agentglass.db in the directory the server started from used to be
 * reported only on stderr, among the dev server's output, where nobody reads
 * it — while the dashboard showed a different history than the one that file
 * holds. The app says it now, with both paths and what to do.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DbNoticeView } from "../src/components/DbNoticeBanner.tsx";

const stray = "/home/dev/orbit/server/agentglass.db";
const db = "/home/dev/.local/share/agentglass/agentglass.db";
const render = (kind: "copied" | "ignored") =>
  renderToStaticMarkup(React.createElement(DbNoticeView, { notice: { kind, stray, db }, onClose: () => {} }));

describe("the second-database notice", () => {
  test("two databases: names both, says which is in use, and how to switch without guessing", () => {
    const html = render("ignored");
    expect(html).toContain(stray);
    expect(html).toContain(db);
    expect(html, "no command to move the file").toContain(`mv ${stray} ${db}`);
    expect(html, "moving it over replaces the current history, and the notice must say so").toContain("replaces");
    expect(html).toContain("role=\"alert\"");
  });

  test("a copy: says the history was brought over and the original is untouched", () => {
    const html = render("copied");
    expect(html).toContain(stray);
    expect(html).toContain(db);
    expect(html).toContain("untouched");
    expect(html, "a copy that already happened is not an instruction to move anything").not.toContain("mv ");
  });
});
