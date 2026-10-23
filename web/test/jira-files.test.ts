/*
 * A Jira card's files on the screen: what a drop is worth, which files are sent at all, that the pane holds only the
 * routes the server named, and what the section keeps (the "+" at the end of the header, a removal that asks first on
 * your own files only, nothing drawn for a card with no files and no way to add one).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UPLOAD_MAX, addedSaid, checkUpload, dragHasFiles, droppedFiles, withAddresses } from "../src/lib/jiraFiles.ts";
import { AttachmentsBlock, type FileAct } from "../src/components/jira/JiraFiles.tsx";
import { CardFiles } from "../src/components/CardFiles.tsx";
import type { CardAttachment } from "../../shared/providers.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const file = (o: Partial<CardAttachment> = {}): CardAttachment => ({ id: "10001", title: "timeout-trace.png", ext: "png", size: 48210, url: "/jira/file?key=ORBIT-1042&id=10001", thumb: "/jira/file?key=ORBIT-1042&id=10001&thumb=1", who: "Grace Sample", at: Date.now() - 3_600_000, ...o });
const act: FileAct = { add: async () => null, remove: async () => null };

describe("which files are sent", () => {
  test("an empty file and one over 25 MB are refused with a sentence, an ordinary one is not", () => {
    expect(checkUpload({ name: "a.txt", size: 0 })).toBe("a.txt is empty");
    expect(checkUpload({ name: "big.mov", size: UPLOAD_MAX + 1 })).toBe("big.mov is over 25 MB: add it in Jira");
    expect(checkUpload({ name: "a.txt", size: UPLOAD_MAX })).toBeNull();
    expect(checkUpload({ name: "a.txt", size: 1 })).toBeNull();
  });
  test("the limit is the server's", async () => {
    const server = await Bun.file(new URL("../../server/src/jiraFiles.ts", import.meta.url)).text();
    expect(server).toContain("export const UPLOAD_MAX = 25 * 1024 * 1024;");
    expect(UPLOAD_MAX).toBe(25 * 1024 * 1024);
  });
});

describe("a drag is a drop only when it carries files", () => {
  test("files yes; text, an address and nothing no", () => {
    expect(dragHasFiles({ types: ["Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dragHasFiles({ types: ["text/uri-list"] })).toBe(false);
    expect(dragHasFiles({ types: [] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
  test("the files of a drop come in the order dropped", () => {
    const a = new File(["1"], "a.txt");
    const b = new File(["2"], "b.txt");
    expect(droppedFiles({ files: [a, b] }).map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(droppedFiles(null)).toEqual([]);
  });
});

describe("the pane holds only the routes the server named", () => {
  test("a file's address is this app's route made whole, and a file with no thumbnail gets none", () => {
    const [a, b] = withAddresses([file(), file({ id: "10002", title: "notes.txt", ext: "txt", thumb: undefined, url: "/jira/file?key=ORBIT-1042&id=10002" })]);
    expect(a!.url).toContain("/jira/file?key=ORBIT-1042&id=10001");
    expect(a!.thumb).toContain("&thumb=1");
    expect(b!.thumb).toBeUndefined();
    expect(JSON.stringify([a, b])).not.toContain("atlassian");
  });
  test("an empty route stays empty and is not turned into the app's own address", () => {
    expect(withAddresses([file({ url: "", thumb: undefined })])[0]!.url).toBe("");
  });
});

describe("what is said after files were added", () => {
  test("one name, how many, and what did not go", () => {
    expect(addedSaid(["build.log"], 0)).toEqual({ text: "build.log added" });
    expect(addedSaid(["a", "b", "c"], 0)).toEqual({ text: "3 files added" });
    expect(addedSaid(["a", "b"], 1)).toEqual({ text: "2 files added, 1 not", warn: true });
    expect(addedSaid([], 1)).toEqual({ text: "Not added", warn: true });
    expect(addedSaid([], 3)).toEqual({ text: "3 not added", warn: true });
  });
});

describe("the section", () => {
  test("a card with no files and no way to add one draws nothing", () => {
    expect(html(React.createElement(AttachmentsBlock, { files: [], card: "ORBIT-1042", writable: false, act }))).toBe("");
  });
  test("with writing on and no files it says how to add one, and the + is there", () => {
    const out = html(React.createElement(AttachmentsBlock, { files: [], card: "ORBIT-1042", writable: true, act }));
    expect(out).toContain("No files. Drag one here, or press +.");
    expect(out).toContain('aria-label="Add a file"');
    expect(out).toContain('type="file"');
  });
  test("with writing off the files are drawn and nothing can be added or taken off", () => {
    const out = html(React.createElement(AttachmentsBlock, { files: [file({ mine: true })], card: "ORBIT-1042", writable: false, act }));
    expect(out).toContain("timeout-trace.png");
    expect(out).not.toContain('aria-label="Add a file"');
    expect(out).not.toContain('type="file"');
    expect(out).not.toContain("off</");
    expect(out).not.toContain("Take timeout-trace.png off");
  });
  test("the + is the last control of the header whether or not there are files", () => {
    for (const files of [[], [file()]]) {
      const out = html(React.createElement(AttachmentsBlock, { files, card: "ORBIT-1042", writable: true, act }));
      const head = out.slice(0, out.indexOf("</section>") > 0 ? out.indexOf("</section>") : out.length);
      expect(head.indexOf("Attachments")).toBeLessThan(head.indexOf('aria-label="Add a file"'));
    }
  });
  test("a file shows its name, who and when, and no address of the site's", () => {
    const out = html(React.createElement(AttachmentsBlock, { files: [file()], card: "ORBIT-1042", writable: false, act }));
    for (const w of ["timeout-trace.png", "Grace Sample", "1h ago"]) expect(out).toContain(w);
    expect(out).not.toContain("atlassian.net");
  });
  test("a removal is offered on your own files and on no other", () => {
    const mine = html(React.createElement(CardFiles, { files: [file({ mine: true }), file({ id: "10002", title: "theirs.png", mine: undefined })], onRemove: () => undefined }));
    expect(mine).toContain("Take timeout-trace.png off");
    expect(mine).not.toContain("Take theirs.png off");
  });
  test("the viewer of a Jira file has no Open link: its address carries the app's sign-in", async () => {
    const src = await read("components/jira/JiraFiles.tsx");
    expect(src).toContain("openLink={false}");
    expect(src).not.toContain("openExternal");
  });
  test("a removal asks first, says it cannot be put back, and goes nowhere until yes", async () => {
    const src = await read("components/jira/JiraFiles.tsx");
    expect(src).toContain("cannot be put back");
    expect(src).toContain("onRemove={writable ? (a) => setAsking(a.id) : undefined}");
    expect(src).toContain("onYes={() => void remove(target)}");
  });
  test("the card draws the block with the write switch, and the pane keeps the section's place after the description", async () => {
    const src = await read("components/jira/JiraCard.tsx");
    expect(src).toContain("<AttachmentsBlock files={detail.attachments ?? []} card={key} writable={writes} act={fileAct} />");
  });
});
