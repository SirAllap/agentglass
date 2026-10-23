/*
 * A Jira person's picture on the board and the card pane.
 *
 * Measured: the Jira Cloud picture is a Gravatar URL falling back to an
 * Atlassian initials image; neither host is in the desktop CSP's img-src, so
 * the WHO column and the "mine" chip drew a broken-image icon. The fix is the
 * same as for a GitHub avatar: the picture rides the sidecar's asset proxy.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
import { isJiraAvatarUrl } from "../../shared/avatarHost.ts";
const stubGlobal = globalStubs();

const GRAVATAR = "https://secure.gravatar.com/avatar/0123abcd?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FOR-3.png";
const CLICKUP = "https://attachments.clickup.com/profilePictures/1_abc.jpg";

let avatarSrc: typeof import("../src/lib/avatarSrc.ts").avatarSrc;
let Face: typeof import("../src/components/AssignPicker.tsx").Face;

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
  avatarSrc = (await import("../src/lib/avatarSrc.ts")).avatarSrc;
  Face = (await import("../src/components/AssignPicker.tsx")).Face;
});

describe("avatarSrc", () => {
  test("a Jira picture goes through the asset proxy, encoded", () => {
    const src = avatarSrc(GRAVATAR);
    expect(src).toContain("/prs/asset?url=");
    expect(src).toContain(encodeURIComponent(GRAVATAR));
    expect(src.startsWith("https://secure.gravatar.com")).toBe(false);
  });

  test("a picture the CSP already allows is left alone", () => {
    expect(avatarSrc(CLICKUP)).toBe(CLICKUP);
  });

  test("a lookalike is not mistaken for a Jira host", () => {
    expect(isJiraAvatarUrl("https://secure.gravatar.com.evil.example/a")).toBe(false);
    expect(isJiraAvatarUrl("https://secure.gravatar.com@evil.example/a")).toBe(false);
    // Same host spelled differently is the same host; a different scheme, port or look-alike is not.
    expect(isJiraAvatarUrl("https://SECURE.GRAVATAR.COM/avatar/x")).toBe(true);
    expect(isJiraAvatarUrl("https://secure.gravatar.com./avatar/x")).toBe(true);
    expect(isJiraAvatarUrl("http://secure.gravatar.com/avatar/x")).toBe(false);
    expect(isJiraAvatarUrl("https://secure.gravatar.com:8443/avatar/x")).toBe(false);
    expect(isJiraAvatarUrl("https://secure.gravatar.com.\u200b.evil.example/a")).toBe(false);
    expect(isJiraAvatarUrl("https://s\u0435cure.gravatar.com/avatar/x")).toBe(false);
    expect(isJiraAvatarUrl("http://secure.gravatar.com/a")).toBe(false);
    expect(avatarSrc("https://secure.gravatar.com.evil.example/a")).toBe("https://secure.gravatar.com.evil.example/a");
  });
});

describe("a face with a Jira picture", () => {
  test("renders the proxied src, and initials when there is no picture", () => {
    const withPic = renderToStaticMarkup(React.createElement(Face, { m: { avatar: GRAVATAR, initials: "OR" } }));
    expect(withPic).toContain("/prs/asset?url=");
    expect(withPic).not.toContain('src="https://secure.gravatar.com');
    const bare = renderToStaticMarkup(React.createElement(Face, { m: { initials: "OR" } }));
    expect(bare).not.toContain("<img");
    expect(bare).toContain(">OR<");
  });
});

describe("no tracker component sets a raw avatar src", () => {
  const root = join(import.meta.dir, "../src/components");
  const files = ["TasksPanel.tsx", "AssignPicker.tsx", "TrackerPeoplePick.tsx", "jira/JiraActivity.tsx", "tasks/Composer.tsx"];
  test("every <img> fed by an avatar goes through avatarSrc", () => {
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      const raw = src.match(/<img\s+src=\{(?:[\w.]*avatar|myFace|m\.avatar|p\.avatar|e\.avatar|person\.avatar)\}/g);
      expect(raw, f).toBeNull();
      expect(src, f).toContain("avatarSrc(");
    }
  });
  test("the faces fall back to initials when the picture fails", () => {
    for (const f of ["TasksPanel.tsx", "AssignPicker.tsx", "TrackerPeoplePick.tsx", "jira/JiraActivity.tsx"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toContain("onError");
    }
  });
  test("the test reads files that exist", () => {
    expect(readdirSync(root)).toContain("TasksPanel.tsx");
  });
});

describe("every Jira face goes through the proxy helper and falls back", () => {
  test("CardFace and the activity avatar use avatarSrc and handle a failed load", async () => {
    const face = await Bun.file(new URL("../src/lib/priority.tsx", import.meta.url)).text();
    const cardFace = face.slice(face.indexOf("export function CardFace("));
    expect(cardFace).toContain("avatarSrc(p.avatar)");
    expect(cardFace).toContain("onError");
    expect(cardFace).not.toContain("src={p.avatar}");
    const panel = await Bun.file(new URL("../src/components/CardEventRun.tsx", import.meta.url)).text();
    const at = panel.indexOf("avatarSrc(e.avatar)");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(at, at + 400)).toContain("onError");
  });
});
